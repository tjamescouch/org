#!/usr/bin/env bun
// src/app.ts

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";

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

installTtyGuard();

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
  try {
    const out = execFileSync("git", ["-C", seed, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  let d = path.resolve(seed);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
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
      setTimeout(() => { /* keep loop alive while idle */ }, 60_000);
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
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // newest last
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

async function openPager(filePath: string) {
  await withCookedTTY(async () => {
    await new Promise<void>((resolve) => {
      const pager = process.env.ORG_PAGER || "delta -s || less -R || cat";
      const p = spawn("sh", ["-lc", `${pager} ${JSON.stringify(filePath)}`], { stdio: "inherit" });
      p.on("exit", () => resolve());
    });
  });
}

async function askYesNo(prompt: string): Promise<boolean> {
  const rl = await import("readline");
  return await new Promise<boolean>((resolve) => {
    const rli = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
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
  scheduler: RoundRobinScheduler,
  projectDir: string,
  reviewMode: "ask" | "auto" | "never"
) {
  try {
    await scheduler?.drain?.();
  } catch { /* ignore */ }
  try {
    scheduler?.stop?.();
  } catch { /* ignore */ }

  // Finalize all sandboxes (Podman/no-sandbox). We ignore the return payload to keep this drop‑in.
  try { await (sandboxMangers as any)?.finalizeAll?.(); } catch { /* ignore */ }

  const review = new ReviewManager(projectDir, reviewMode);
  const isTTY = process.stdout.isTTY;

  const patches = await listRecentSessionPatches(projectDir, 120);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }

  for (const patch of patches) {
    Logger.info(`Patch ready: ${patch}`);

    if (reviewMode === "never") {
      continue; // just leave artifacts/patch on disk
    }

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

    // reviewMode === 'ask' and TTY
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

  // Give the enqueue a tick to land before starting the loop
  await new Promise<void>((r) => setTimeout(r, 0));

  // Finalization guard: ensure we finalize once
  let finalized = false;
  const doFinalize = async (code: number) => {
    if (finalized) { process.exit(code); return; }
    finalized = true;
    try {
      await finalizeOnce(scheduler, projectDir, reviewMode);
    } catch (e) {
      Logger.error(e);
    } finally {
      process.exit(code);
    }
  };

  // SIGTERM should finalize; SIGINT remains "fast abort" (InputController handles it)
  process.on("SIGTERM", () => { void doFinalize(143); });
  process.on("exit", (code) => { /* last chance if not finalized (non-blocking) */ });

  // Run
  await scheduler.start();

  // Non-interactive (--prompt "…") or explicit scheduler stop comes back here.
  await doFinalize(0);
}

main().catch((e) => {
  Logger.info(e);
  process.exit(1);
});
