#!/usr/bin/env bun
// src/app.ts

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";

import { R } from "./runtime/runtime";
import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { installTtyGuard, withCookedTTY } from "./input/tty-guard";
import { ReviewManager } from "./scheduler/review-manager";
import { sandboxMangers } from "./sandbox/session";
import { SchedulerLike, TtyController } from "./input/tty-controller";
import Passthrough from "./input/passthrough";
import { trace } from "./debug/trace";

type InputPort = {
  askUser(fromAgent: string, content: string): Promise<void>;
  setScheduler(s: unknown): void;
  start(): void;
  close?(graceful?: boolean): Promise<void>;
};

installTtyGuard();

/** ---------- CLI parsing ---------- */
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (typeof v === "string") out[k] = v;
      else {
        key = k;
        out[k] = true;
      }
    } else if (key) {
      out[key] = a;
      key = null;
    } else {
      if (!("prompt" in out)) out["prompt"] = a;
      else out[`arg${Object.keys(out).length}`] = a;
    }
  }
  return out;
}

function resolveProjectDir(seed: string): string {
  try {
    const out = execFileSync("git", ["-C", seed, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    if (out) return out;
  } catch {}
  let d = path.resolve(seed);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(
    `Could not locate project root from ${seed}. Pass --project <dir> or run inside the repo.`,
  );
}

// very small arg parser for -C/--project
function getProjectFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-C" || argv[i] === "--project") return argv[i + 1];
  }
  return R.env.ORG_PROJECT_DIR;
}

function enableDebugIfRequested(args: Record<string, string | boolean>) {
  if (args["debug"] || R.env.DEBUG) {
    R.env.DEBUG = String(args["debug"] ?? R.env.DEBUG ?? "1");
    Logger.info("[DBG] debug logging enabled");
  }
}

function setupProcessGuards() {
  const dbgOn = !!R.env.DEBUG && R.env.DEBUG !== "0" && R.env.DEBUG !== "false";
  if (dbgOn) {
    R.on("beforeExit", (code) => {
      Logger.info("[DBG] beforeExit", code, "— scheduler stays alive unless Ctrl+C");
      setTimeout(() => {}, 60_000);
    });
    R.on("uncaughtException", (e) => {
      Logger.info("[DBG] uncaughtException:", e);
    });
    R.on("unhandledRejection", (e) => {
      Logger.info("[DBG] unhandledRejection:", e);
    });
    R.stdin.on("end", () => Logger.info("[DBG] stdin end"));
    R.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
    R.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));
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
  recipeSystemPrompt?: string | null,
): AgentSpec[] {
  const list = String(spec || "alice:lmstudio")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const out: AgentSpec[] = [];
  for (const item of list) {
    const [id, kindRaw = "mock"] = item.split(":");
    const kind = (kindRaw as ModelKind) || "mock";
    if (kind === "mock") {
      const m = new MockModel(id);
      out.push({ id, kind, model: m });
    } else if (kind === "lmstudio") {
      if (llmDefaults.protocol !== "openai")
        throw new Error(`Unsupported protocol: ${llmDefaults.protocol}`);
      const driver = makeStreamingOpenAiLmStudio({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: (llmDefaults as any).apiKey,
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

/** ---------- helpers for finalization/review ---------- */

async function listRecentSessionPatches(projectDir: string, minutes = 20): Promise<string[]> {
  const root = path.join(projectDir, ".org", "runs");
  const out: string[] = [];
  try {
    const entries = await fsp.readdir(root);
    const cutoff = Date.now() - minutes * 60_000;
    for (const d of entries) {
      const patch = path.join(root, d, "session.patch");
      try {
        const st = await fsp.stat(patch);
        if (st.isFile() && st.size > 0 && st.mtimeMs >= cutoff) out.push(patch);
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

async function openPager(filePath: string) {
  await withCookedTTY(async () => {
    await new Promise<void>((resolve) => {
      const pager = R.env.ORG_PAGER || "delta -s || less -R || cat";
      const p = spawn("sh", ["-lc", `${pager} ${JSON.stringify(filePath)}`], { stdio: "inherit" });
      p.on("exit", () => resolve());
    });
  });
}

async function askYesNo(prompt: string): Promise<boolean> {
  const rl = await import("readline");
  return await new Promise<boolean>((resolve) => {
    const rli = rl.createInterface({ input: R.stdin, output: R.stdout, terminal: true });
    rli.question(`${prompt} `, (ans) => {
      rli.close();
      const a = String(ans || "").trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

function applyPatch(projectDir: string, patchPath: string) {
  execFileSync("git", ["-C", projectDir, "apply", "--index", patchPath], { stdio: "inherit" });
}

/**
 * Finalize: drain/stop scheduler, finalize sandboxes, and review/apply session patches.
 */
async function finalizeOnce(
  scheduler: SchedulerLike | null,
  projectDir: string,
  reviewMode: "ask" | "auto" | "never",
) {
  try {
    await scheduler?.drain?.();
  } catch {}
  try {
    await (sandboxMangers as any)?.finalizeAll?.();
  } catch {}
  try {
    scheduler?.stop?.();
  } catch {}

  const isTTY = R.stdout.isTTY;
  const patches = await listRecentSessionPatches(projectDir, 120);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }

  for (const patch of patches) {
    Logger.info(`Patch ready: ${patch}`);

    if (reviewMode === "never") continue;

    if (reviewMode === "auto" || !isTTY) {
      try {
        applyPatch(projectDir, patch);
        Logger.info("Patch auto-applied.");
      } catch (e: any) {
        Logger.error("Auto-apply failed:", e?.message || e);
        Logger.info(`You can apply manually: git -C ${projectDir} apply --index ${patch}`);
      }
      continue;
    }

    await openPager(patch);
    const yes = await askYesNo("Apply this patch? [y/N]");
    if (yes) {
      try {
        applyPatch(projectDir, patch);
        Logger.info("Patch applied.");
      } catch (e: any) {
        Logger.error("Apply failed:", e?.message || e);
        Logger.info(`You can apply manually: git -C ${projectDir} apply --index ${patch}`);
      }
    } else {
      Logger.info("Patch NOT applied.");
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as any).Bun ? Bun.argv.slice(2) : R.argv.slice(2));
  const args = parseArgs(argv);

  if (args["ui"] === "tmux" && R.env.ORG_TMUX !== "1") {
    const sandbox = R.env.SANDBOX_BACKEND ?? "podman"; // "none" = host
    const tmuxScope: "host" | "container" =
      (R.env.ORG_TMUX_SCOPE as any) ?? (sandbox === "none" ? "host" : "container");

    const { doctorTmux } = await import("./cli/doctor");
    if (tmuxScope === "host") {
      if ((await doctorTmux("host")) !== 0) R.exit(1);
    }
    const { launchTmuxUI } = await import("./ui/tmux");
    const code = await launchTmuxUI(R.argv, tmuxScope);
    R.exit(code);
  }

  enableDebugIfRequested(args);
  setupProcessGuards();

  const seed = getProjectFromArgs(R.argv) ?? R.cwd();
  const projectDir = resolveProjectDir(seed);

  // ---- Recipe wiring ----
  const recipeName =
    (typeof args["recipe"] === "string" && args["recipe"]) || (R.env.ORG_RECIPE || "");
  const recipe = getRecipe(recipeName || null);

  if (R.env.DEBUG && R.env.DEBUG !== "0" && R.env.DEBUG !== "false") {
    Logger.info("[DBG] args:", args);
    if (recipe) Logger.info("[DBG] recipe:", recipe.name);
  }

  // Budgets
  let maxTools = Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20)));

  // Mode + (optional) tool allowlist
  computeMode({ allowTools: recipe?.allowTools });

  Logger.info(
    "Press Esc to gracefully exit (saves sandbox patches). Use Ctrl+C for immediate exit.",
  );

  // Build agents, set recipe system prompt if supported
  const agentSpecs = parseAgents(
    String(args["agents"] || "alice:lmstudio"),
    cfg.llm,
    recipe?.system ?? null,
  );
  if (agentSpecs.length === 0) {
    Logger.error(
      'No agents. Use --agents "alice:lmstudio,bob:mock" or "alice:mock,bob:mock"',
    );
    R.exit(1);
  }

  const agents = agentSpecs.map((a) => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) =>
      a.model.respond(prompt, budget, peers, cb),
    guardOnIdle: (state: any) => a.model.guardOnIdle?.(state) ?? null,
    guardCheck: (route: any, content: string, peers: string[]) =>
      a.model.guardCheck?.(route, content, peers) ?? null,
  }));

  trace("app", "agents parsed", { agents: agents?.map((a) => a.id) });

  // Late-bind input so scheduler can call back
  let input!: InputPort;

  const reviewMode = (args["review"] ?? "ask") as "ask" | "auto" | "never";
  const scheduler: SchedulerLike = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
    projectDir,
    reviewMode,
    // promptEnabled: if --prompt is provided as a string we treat it as non-interactive seed
    promptEnabled: typeof args["prompt"] === "boolean" ? (args["prompt"] as boolean) : R.stdin.isTTY,
  });
  trace("app", "scheduler constructed");

  // Seed initial instruction: CLI --prompt wins; else recipe.kickoff; else undefined
  const kickoff: string | undefined =
    typeof args["prompt"] === "string"
      ? (args["prompt"] as string)
      : typeof recipe?.kickoff === "string"
      ? (recipe!.kickoff as string)
      : undefined;

  if (R.env.DEBUG && R.env.DEBUG !== "0" && R.env.DEBUG !== "false") {
    Logger.info(
      "[DBG] kickoff:",
      typeof kickoff === "string" ? kickoff : "(none)",
    );
  }

  // ---- Build input (TTY or non-TTY) ----
  if (R.stdin.isTTY) {
    input = new TtyController({
      waitOverlayMessage: "Waiting for agent to finish",
      waitSuppressOutput: true,
      stdin: R.stdin,
      stdout: R.stdout,
      // prompt label (banner), not the seed text
      prompt: String(args["banner"] ?? "User: "),
      interjectKey: String(args["interject-key"] ?? "i"),
      interjectBanner: String(args["banner"] ?? "You: "),
      finalizer: async () => {
        await finalizeOnce(scheduler, projectDir, reviewMode);
      },
    });
  } else {
    input = new Passthrough({
      stdin: R.stdin,
      stdout: R.stdout,
      scheduler,
      finalizer: async () => {
        await finalizeOnce(scheduler, projectDir, reviewMode);
      },
    });
  }

  input.setScheduler(scheduler as any);
  input.start();
  trace("app", "input started", { tty: (R.stdin as any).isTTY });

  // ---- Kickoff (seed) ----
  if (typeof kickoff === "string" && kickoff.length > 0) {
    const s: any = scheduler;
    if (s.enqueueUserText) {
      trace("app", "enqueueUserText(kickoff)");
      await s.enqueueUserText(kickoff);
    } else if (s.enqueue) {
      trace("app", "enqueue(kickoff)");
      await s.enqueue({ role: "user", content: kickoff });
    } else if (s.send) {
      trace("app", "send(kickoff)");
      await s.send(kickoff);
    } else {
      trace("app", "NO ENQUEUE API!");
    }
  }

  if (R.env.DEBUG && R.env.DEBUG !== "0" && R.env.DEBUG !== "false") {
    Logger.info("[DBG] agents:", agents.map((a) => a.id).join(", "));
    Logger.info("[DBG] maxTools:", maxTools);
  }

  // Ensure enqueue lands, then start the loop
  await new Promise<void>((r) => setTimeout(r, 0));

  // ---- Run scheduler until stopped ----
  const reviewManager = new ReviewManager(projectDir, reviewMode);
  await scheduler.start();
  await reviewManager.finalizeAndReview();

  // Non-interactive or explicit scheduler stop comes back here.
  await finalizeOnce(scheduler, projectDir, reviewMode);
  R.exit(0);
}

main().catch((e) => {
  Logger.info(e);
  R.exit(1);
});
