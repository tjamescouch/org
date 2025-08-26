#!/usr/bin/env bun
// src/app.ts

import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { InputController } from "./input/controller";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { installTtyGuard } from "./input/tty-guard";
import { ReviewManager } from "./scheduler/review-manager";

import { parseArgs, getProjectFromArgs, enableDebugIfRequested } from "./cli/args";
import { resolveProjectDir } from "./project/resolve";
import { setupProcessGuards } from "./runtime/process-guards";
import { disposeHotkeys, installHotkeys } from "./runtime/hotkeys";
import { finalizeRun } from "./review/finalize-run";

installTtyGuard();

/** ---------- Mode / safety ---------- */
function computeMode(extra?: { allowTools?: string[] | undefined }) {
  const interactive = true;
  const cfg = loadConfig();
  const safe = !!(cfg as any)?.runtime?.safe;
  ExecutionGate.configure({ safe, interactive, allowTools: extra?.allowTools });
  return { interactive, safe };
}

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: any };

function parseAgents(
  spec: string | undefined,
  llmDefaults: { model: string; baseUrl: string; protocol: "openai"; apiKey?: string },
  recipeSystemPrompt?: string | null
): AgentSpec[] {
  const list = String(spec || "alice:lmstudio,bob:lmstudio").split(",").map(x => x.trim()).filter(Boolean);
  const out: AgentSpec[] = [];
  for (const item of list) {
    const [id, kindRaw = "mock"] = item.split(":");
    const kind = (kindRaw as ModelKind) || "mock";
    if (kind === "mock") {
      const m = new MockModel(id);
      out.push({ id, kind, model: m });
    } else if (kind === "lmstudio") {
      if (llmDefaults.protocol !== "openai") throw new Error(`Unsupported protocol: ${llmDefaults.protocol}`);
      const driver = makeStreamingOpenAiLmStudio({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: (llmDefaults as any).apiKey
      });
      const agentModel = new LlmAgent(id, driver, llmDefaults.model) as any;
      if (recipeSystemPrompt && typeof agentModel.setSystemPrompt === "function") {
        agentModel.setSystemPrompt(recipeSystemPrompt);
      }
      out.push({ id, kind, model: agentModel });
    } else {
      throw new Error(`Unknown model kind: ${kindRaw}`);
    }
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as any).Bun ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);
  enableDebugIfRequested(args);
  setupProcessGuards();

  // ---- main entry ----
  const seed = getProjectFromArgs(process.argv) ?? process.cwd();
  const projectDir = resolveProjectDir(seed);

  // ---- Recipe wiring ----
  const recipeName =
    (typeof args["recipe"] === "string" && args["recipe"]) ||
    (process.env.ORG_RECIPE || "");
  const recipe = getRecipe(recipeName || null);

  if (process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false") {
    Logger.info("[DBG] args:", args);
    if (recipe) Logger.info("[DBG] recipe:", recipe.name);
  }

  // Budgets
  const maxTools = Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20)));

  // Mode + (optional) tool allowlist
  computeMode({ allowTools: recipe?.allowTools });

  Logger.info("Press Esc to gracefully exit (saves sandbox patches). Use Ctrl+C for immediate exit.");

  // Build agents, set recipe system prompt if supported
  const agentSpecs = parseAgents(String(args["agents"] || "alice:lmstudio"), cfg.llm, recipe?.system ?? null);
  if (agentSpecs.length === 0) {
    Logger.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) => a.model.respond(prompt, budget, peers, cb),
    guardOnIdle: (state: any) => a.model.guardOnIdle?.(state) ?? null,
    guardCheck: (route: any, content: string, peers: string[]) => a.model.guardCheck?.(route, content, peers) ?? null,
  }));

  // IO + scheduler
  const input = new InputController({
    interjectKey: String(args["interject-key"] || "i"),
    interjectBanner: String(args["banner"] || "You: "),
    exitOnEsc: false,                       // ESC handled at app level
    finalizer: async () => { /* no-op here */ },
  });

  const reviewMode = (args["review"] ?? "ask") as "ask" | "auto" | "never";

  const scheduler = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
    projectDir,
    reviewMode,
    promptEnabled: (typeof args["prompt"] === "boolean" ? args["prompt"] : process.stdin.isTTY),
  });

  const reviewManager = new ReviewManager(projectDir, reviewMode);

  input.attachScheduler(scheduler);

  if (process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false") {
    Logger.info("[DBG] agents:", agents.map(a => a.id).join(", "));
    Logger.info("[DBG] maxTools:", maxTools);
  }

  // Seed initial instruction: CLI --prompt wins; else recipe.kickoff; else ask.
  let kickoff: string | boolean | undefined;
  if (args["prompt"] === true) kickoff = true;                   // explicit ask
  else if (typeof args["prompt"] === "string") kickoff = args["prompt"];
  else if (recipe?.kickoff) kickoff = recipe.kickoff;

  if (process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false") {
    Logger.info("[DBG] kickoff:", typeof kickoff === "string" ? kickoff : kickoff === true ? "(ask)" : "(none)");
  }

  // --- ESC graceful finalize (non-blocking hotkey) ---
  //installHotkeys({
  //  onEsc: async () => {
  //    Logger.info("ESC: graceful shutdown requested…");
  //    try {
  //      await finalizeRun(scheduler, reviewManager, projectDir, reviewMode);
  //    } finally {
  //      disposeHotkeys();
  //      process.exit(0);
  //    }
  //  },
  //  onCtrlC: () => {
  //    // Fast abort; your InputController may also trap SIGINT
  //    disposeHotkeys();
  //    process.exit(130);
  //  },
  //});

  await input.askInitialAndSend(kickoff);

  // Give the enqueue a tick to land before starting the loop
  await new Promise<void>((r) => setTimeout(r, 0));

  // Run
  await scheduler.start();
  await reviewManager.finalizeAndReview(); // end-of-run (non-interactive path)

  // Final apply/review at the end too (idempotent)
  await finalizeRun(scheduler, reviewManager, projectDir, reviewMode);
  disposeHotkeys();
  process.exit(0);
}

main().catch((e) => {
  Logger.info(e);
  disposeHotkeys();
  process.exit(1);
});
