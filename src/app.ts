#!/usr/bin/env bun
// src/app.ts

import * as os from "os";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";

import { R } from "./runtime/runtime";
import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { InputController } from "./input/controller";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { installTtyGuard, withCookedTTY } from "./input/tty-guard";
import { ReviewManager } from "./scheduler/review-manager";
import { sandboxMangers } from "./sandbox/session";
import { launchUI } from "./ui";

installTtyGuard();

/* ======================
 * Logging initialization
 * ====================== */
(function initLogging() {
  // Allowed levels
  const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error"]);

  // mkdir with fallback to tmp
  function ensureDir(pref: string): string {
    let dir = path.resolve(pref);
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      dir = path.join(os.tmpdir(), "org", "logs");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  }

  // ISO-ish filename (keep Z, replace ':' with '-')
  function isoForFilename(d = new Date()): string {
    return d.toISOString().replace(/[:]/g, "-");
  }

  // Determine base app dir for defaults
  // Choose the logs base directory safely
  const baseRaw = process.env.ORG_APPDIR
    ? path.resolve(process.env.ORG_APPDIR)
    : process.cwd();

  // If ORG_APPDIR already ends with "/.org", put logs inside it; otherwise use "<base>/.org"
  const DEFAULT_DIR = baseRaw.endsWith(path.sep + ".org")
    ? path.join(baseRaw, "logs")
    : path.join(baseRaw, ".org", "logs");

  // Resolve directory
  const DIR_INPUT = (process.env.ORG_LOG_DIR ?? "").trim();
  const DIR = ensureDir(DIR_INPUT ? DIR_INPUT : DEFAULT_DIR);

  // Resolve file
  const FILE_INPUT = (process.env.ORG_LOG_FILE ?? "").trim();
  let FILE: string;
  if (FILE_INPUT) {
    FILE = path.isAbsolute(FILE_INPUT)
      ? path.normalize(FILE_INPUT)
      : path.resolve(DIR, path.normalize(FILE_INPUT));
  } else {
    FILE = path.join(DIR, `run-${isoForFilename()}.log`);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  // Resolve level
  const LVL_RAW =
    (process.env.ORG_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info").toLowerCase();
  const LVL = VALID_LEVELS.has(LVL_RAW) ? LVL_RAW : "info";

  // Publish normalized env
  process.env.ORG_LOG_DIR = DIR;
  process.env.ORG_RUN_LOG = FILE;
  process.env.ORG_LOG_LEVEL = LVL;

  // Wire Logger
  Logger.configure({ file: FILE, level: LVL });
  Logger.attachProcessHandlers();
  Logger.info("log file:", FILE);
})();

/* =======================
 * CLI parsing / utilities
 * ======================= */

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
  } catch { /* ignore */ }

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
      setTimeout(() => { /* keep loop alive while idle */ }, 60_000);
    });
    R.on("uncaughtException", (e) => { Logger.info("[DBG] uncaughtException:", e); });
    R.on("unhandledRejection", (e) => { Logger.info("[DBG] unhandledRejection:", e); });
    R.stdin.on("end", () => Logger.info("[DBG] stdin end"));
    R.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
    R.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));
  }
}

/* =======================
 * Mode / agents / helpers
 * ======================= */

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

/* ================
 * Finalization path
 * ================ */

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
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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

async function finalizeOnce(
  scheduler: RoundRobinScheduler | null,
  projectDir: string,
  reviewMode: "ask" | "auto" | "never",
) {
  try { await scheduler?.drain?.(); } catch { /* ignore */ }
  try { await (sandboxMangers as any)?.finalizeAll?.(); } catch { /* ignore */ }
  try { scheduler?.stop?.(); } catch { /* ignore */ }

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

/* =====
 * Main
 * ===== */

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as any).Bun ? Bun.argv.slice(2) : R.argv.slice(2));
  const args = parseArgs(argv);

  // Optional tmux checks only when explicitly requested
  if (args["ui"] === "tmux") {
    const sandbox = R.env.SANDBOX_BACKEND ?? "podman";
    const tmuxScope: "host" | "container" =
      (R.env.ORG_TMUX_SCOPE as any) ?? (sandbox === "none" ? "host" : "container");
    if (tmuxScope === "host") {
      const { doctorTmux } = await import("./cli/doctor");
      if ((await doctorTmux("host")) !== 0) R.exit(1);
    }
  }

  // Launch UI now; allow app to keep wiring; we’ll await at the end
  const ui = (args["ui"] as string | undefined) ?? R.env.ORG_FORCE_UI ?? "console";
  const uiDone = launchUI(ui, argv).catch((e) => { Logger.info(e); return 1; });

  enableDebugIfRequested(args);
  setupProcessGuards();

  const seed = getProjectFromArgs(R.argv) ?? R.cwd();
  const projectDir = resolveProjectDir(seed);

  const recipeName =
    (typeof args["recipe"] === "string" && args["recipe"]) ||
    (R.env.ORG_RECIPE || "");
  const recipe = getRecipe(recipeName || null);

  let maxTools = Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20)));
  computeMode({ allowTools: recipe?.allowTools });

  Logger.info("Press Esc to gracefully exit (saves sandbox patches). Use Ctrl+C for immediate exit.");

  const agentsSpec =
    (typeof args["agents"] === "string" && args["agents"]) ||
    (R.env.ORG_AGENTS as string) ||
    "alice:lmstudio";

  const agentSpecs = parseAgents(agentsSpec, cfg.llm, recipe?.system ?? null);
  if (agentSpecs.length === 0) {
    Logger.error('No agents. Use --agents "alice:lmstudio,bob:mock" or "alice:mock,bob:mock"');
    R.exit(1);
  }

  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) =>
      a.model.respond(prompt, budget, peers, cb),
    guardOnIdle: (state: any) => a.model.guardOnIdle?.(state) ?? null,
    guardCheck: (route: any, content: string, peers: string[]) =>
      a.model.guardCheck?.(route, content, peers) ?? null,
  }));

  const reviewMode = (args["review"] ?? "ask") as "ask" | "auto" | "never";

  const input = new InputController({
    interjectKey: String(args["interject-key"] || "i"),
    interjectBanner: String(args["banner"] || "You: "),
    // ESC finalizer path
    finalizer: async () => { await finalizeOnce(scheduler, projectDir, reviewMode); },
  });

  const scheduler = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
    projectDir,
    reviewMode,
    // promptEnabled: if --prompt present as a string => non-interactive seed
    promptEnabled: (typeof args["prompt"] === "boolean" ? args["prompt"] : R.stdin.isTTY),
  });

  input.attachScheduler(scheduler);

  // Kickoff
  let kickoff: string | boolean | undefined;
  if (args["prompt"] === true) kickoff = true;                   // explicit ask
  else if (typeof args["prompt"] === "string") kickoff = args["prompt"];
  else if (recipe?.kickoff) kickoff = recipe.kickoff;

  await input.askInitialAndSend(kickoff);
  await new Promise<void>((r) => setTimeout(r, 0));

  const reviewManager = new ReviewManager(projectDir, reviewMode);
  await scheduler.start();
  await reviewManager.finalizeAndReview();

  // Wait for UI to finish (ESC/Ctrl+C), then finalize and exit with UI’s code
  const code = await uiDone;
  await finalizeOnce(scheduler, projectDir, reviewMode);
  R.exit(code ?? 0);
}

void main().catch((e) => { Logger.info(e); R.exit(1); });
