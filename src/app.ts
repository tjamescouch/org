#!/usr/bin/env bun
// src/app.ts

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { InputController } from "./input/controller";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";

/** ---------- CLI parsing ---------- */
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (typeof v === "string") out[k] = v;
      else { key = k; out[k] = true; }
    } else if (key) {
      out[key] = a; key = null;
    } else {
      if (!("prompt" in out)) out["prompt"] = a;
      else out[`arg${Object.keys(out).length}`] = a;
    }
  }
  return out;
}


function resolveProjectDir(seed: string): string {
  // 1) If inside a git repo, use its toplevel
  try {
    const out = execFileSync("git", ["-C", seed, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch { }
  // 2) Walk up for a .git folder
  let d = path.resolve(seed);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // 3) Give up
  throw new Error(`Could not locate project root from ${seed}. Pass --project <dir> or run inside the repo.`);
}

// very small arg parser for -C/--project
function getProjectFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-C" || argv[i] === "--project") return argv[i + 1];
  }
  return process.env.ORG_PROJECT_DIR;
}



function enableDebugIfRequested(args: Record<string, string | boolean>) {
  if (args["debug"] || process.env.DEBUG) {
    process.env.DEBUG = String(args["debug"] ?? process.env.DEBUG ?? "1");
    Logger.info("[DBG] debug logging enabled");
  }
}

function setupProcessGuards() {
  const dbgOn = !!process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false";
  if (dbgOn) {
    process.on("beforeExit", (code) => {
      Logger.info("[DBG] beforeExit", code, "— scheduler stays alive unless Ctrl+C");
      setTimeout(() => { }, 60_000); // keep the loop alive if empty
    });
    process.on("uncaughtException", (e) => { Logger.info("[DBG] uncaughtException:", e); });
    process.on("unhandledRejection", (e) => { Logger.info("[DBG] unhandledRejection:", e); });
    process.stdin.on("end", () => Logger.info("[DBG] stdin end"));
    process.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
    process.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));
  }
}

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
  const list = String(spec || "alice:lmstudio").split(",").map(x => x.trim()).filter(Boolean);
  const out: AgentSpec[] = [];
  for (const item of list) {
    const [id, kindRaw = "mock"] = item.split(":");
    const kind = (kindRaw as ModelKind) || "mock";
    if (kind === "mock") {
      const m = new MockModel(id);
      if (recipeSystemPrompt && typeof (m as any).setSystemPrompt === "function") {
        (m as any).setSystemPrompt(recipeSystemPrompt);
      }
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
  let maxTools = Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20)));

  // Mode + (optional) tool allowlist
  computeMode({ allowTools: recipe?.allowTools });

  // Build agents, set recipe system prompt if supported
  const agentSpecs = parseAgents(String(args["agents"] || "alice:lmstudio"), cfg.llm, recipe?.system ?? null);
  if (agentSpecs.length === 0) {
    Logger.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) => a.model.respond(prompt, budget, peers, cb),
    guardOnIdle: (state: any) => a.model.guardOnIdle?.(state) ?? null, guardCheck: (route: any, content: string, peers: string[]) => a.model.guardCheck?.(route, content, peers) ?? null,
  }));

  // IO + scheduler
  const input = new InputController({
    interjectKey: String(args["interject-key"] || "i"),
    interjectBanner: String(args["banner"] || "You: "),
  });

  const scheduler = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
    projectDir,
    reviewMode: args["review"]
  });

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

  await input.askInitialAndSend(kickoff);

  // Give the enqueue a tick to land before starting the loop (harmless no-op if not needed)
  await new Promise<void>((r) => setTimeout(r, 0));

  // Run
  await scheduler.start();
}

main().catch((e) => {
  Logger.info(e);
  process.exit(1);
});
