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
import RandomScheduler from "./scheduler/random-scheduler";
import type { IScheduler, SchedulerLike } from "./scheduler/scheduler";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { ReviewManager } from "./scheduler/review-manager";
import { sandboxMangers } from "./sandbox/session";
import { TtyController } from "./input/tty-controller";
import Passthrough from "./input/passthrough";

// Install once
let installed = false;
const controlContainer: { controller: TtyController | undefined } = { controller: undefined };

/**
 * Hook signals and ensure the controller finalizer runs once.
 */
export function installTtyGuard(): void {
  if (installed) return;
  installed = true;

  const unwind = () => {
    const c = controlContainer.controller;
    if (!c) return;
    c.unwind().catch((e) => Logger.error(e));
  };

  R.on("SIGINT", () => { unwind(); R.exit(130); });
  R.on("SIGTERM", () => { unwind(); R.exit(143); });
  R.on("uncaughtException", (err) => { unwind(); Logger.error?.(err); R.exit(1); });
  R.on("unhandledRejection", (reason: unknown) => { unwind(); Logger.error?.(reason); R.exit(1); });
}

/** Scoped cooked/raw helpers that return promises (safe to `await`). */
export async function withCookedTTY<T>(f: () => Promise<T> | T): Promise<T> {
  const ctl = controlContainer.controller;
  if (!ctl) return await Promise.resolve(f());
  return ctl.withCookedTTY(f);
}
export async function withRawTTY<T>(f: () => Promise<T> | T): Promise<T> {
  const ctl = controlContainer.controller;
  if (!ctl) return await Promise.resolve(f());
  return ctl.withRawTTY(f);
}

installTtyGuard();

// ------------------------------- Args & config -------------------------------

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
  } catch { /* ignore */ }
  let d = path.resolve(seed);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`Could not locate project root from ${seed}. Pass --project <dir> or run inside the repo.`);
}

function enableDebugIfRequested(args: Record<string, string | boolean>) {
  if (args["debug"] || R.env.DEBUG) {
    R.env.DEBUG = String(args["debug"] ?? R.env.DEBUG ?? "1");
    Logger.info("[DBG] debug logging enabled");
  }
}

function computeMode(extra?: { allowTools?: string[] }) {
  const interactive = true;
  const cfg = loadConfig();
  const safe = !!(cfg as unknown as { runtime?: { safe?: boolean } })?.runtime?.safe;
  ExecutionGate.configure({ safe, interactive, allowTools: extra?.allowTools });
}

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: unknown };

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
      out.push({ id, kind, model: new MockModel(id) });
    } else if (kind === "lmstudio") {
      if (llmDefaults.protocol !== "openai") throw new Error(`Unsupported protocol: ${llmDefaults.protocol}`);
      const driver = makeStreamingOpenAiLmStudio({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: llmDefaults.apiKey
      });
      const agentModel = new LlmAgent(id, driver, llmDefaults.model) as unknown;
      if (recipeSystemPrompt && (agentModel as { setSystemPrompt?: (s: string) => void }).setSystemPrompt) {
        (agentModel as { setSystemPrompt: (s: string) => void }).setSystemPrompt(recipeSystemPrompt);
      }
      out.push({ id, kind, model: agentModel });
    } else {
      throw new Error(`Unknown model kind: ${kindRaw}`);
    }
  }
  return out;
}

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

async function finalizeOnce(scheduler: SchedulerLike | null, projectDir: string, reviewMode: "ask" | "auto" | "never") {
  try { await scheduler?.drain?.(); } catch { /* ignore */ }
  try { await (sandboxMangers as { finalizeAll?: () => Promise<void> }).finalizeAll?.(); } catch { /* ignore */ }
  try { await scheduler?.stop?.(); } catch { /* ignore */ }

  const patches = await listRecentSessionPatches(projectDir, 120);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }

  for (const patch of patches) {
    Logger.info(`Patch ready: ${patch}`);
    if (reviewMode === "never") continue;

    if (reviewMode === "auto" || !R.stdout.isTTY) {
      try { applyPatch(projectDir, patch); Logger.info("Patch auto-applied."); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); Logger.error("Auto-apply failed:", msg); Logger.info(`You can apply manually: git -C ${projectDir} apply --index ${patch}`); }
      continue;
    }

    await openPager(patch);
    const yes = await askYesNo("Apply this patch? [y/N]");
    if (yes) {
      try { applyPatch(projectDir, patch); Logger.info("Patch applied."); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); Logger.error("Apply failed:", msg); Logger.info(`You can apply manually: git -C ${projectDir} apply --index ${patch}`); }
    } else {
      Logger.info("Patch NOT applied.");
    }
  }
}

// ---------------------------------- main ----------------------------------

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as unknown as { Bun?: unknown }).Bun ? Bun.argv.slice(2) : R.argv.slice(2));
  const args = parseArgs(argv);

  // tmux handoff
  if (args["ui"] === "tmux" && R.env.ORG_TMUX !== "1") {
    const sandbox = R.env.SANDBOX_BACKEND ?? "podman";
    const tmuxScope: "host" | "container" =
      (R.env.ORG_TMUX_SCOPE as "host" | "container" | undefined) ?? (sandbox === "none" ? "host" : "container");
    const { doctorTmux } = await import("./cli/doctor");
    if (tmuxScope === "host") {
      if ((await doctorTmux("host")) !== 0) R.exit(1);
    }
    const { launchTmuxUI } = await import("./ui/tmux");
    const code = await launchTmuxUI(R.argv, tmuxScope);
    R.exit(code);
  }

  enableDebugIfRequested(args);
  computeMode({ allowTools: getRecipe(null)?.allowTools });

  Logger.info("Press Esc to gracefully exit (saves sandbox patches). Use Ctrl+C for immediate exit.");

  const projectDir = resolveProjectDir(R.cwd());
  const recipeName = (typeof args["recipe"] === "string" && args["recipe"]) || (R.env.ORG_RECIPE || "");
  const recipe = getRecipe(recipeName || null);

  // Build agents
  const agentSpecs = parseAgents(String(args["agents"] || "alice:lmstudio"), cfg.llm, recipe?.system ?? null);
  if (agentSpecs.length === 0) {
    Logger.error('No agents. Use --agents "alice:lmstudio,bob:mock" or "alice:mock,bob:mock"');
    R.exit(1);
  }
  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) =>
      (a.model as { respond: typeof LlmAgent.prototype.respond }).respond(prompt, budget, peers, cb),
    guardOnIdle: (state: unknown) => (a.model as { guardOnIdle?: (s: unknown) => unknown }).guardOnIdle?.(state) ?? null,
    guardCheck: (route: unknown, content: string, peers: string[]) =>
      (a.model as { guardCheck?: (r: unknown, c: string, p: string[]) => unknown }).guardCheck?.(route, content, peers) ?? null,
  }));

  // kickoff FIRST so we can set promptEnabled properly
  const kickoff: string | undefined =
    typeof args["prompt"] === "string" ? String(args["prompt"])
      : typeof recipe?.kickoff === "string" ? recipe!.kickoff
        : undefined;

  const reviewMode = (args["review"] ?? "ask") as "ask" | "auto" | "never";

  const scheduler: IScheduler = new RandomScheduler({
    agents,
    maxTools: Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20))),
    onAskUser: (fromAgent: string, content: string) =>
      controlContainer.controller?.askUser(fromAgent, content) ?? Promise.resolve(undefined),
    projectDir,
    reviewMode,
    promptEnabled: true
    //promptEnabled: typeof args["prompt"] === "boolean" ? args["prompt"] : kickoff ? false : R.stdin.isTTY,
  });

  // Build input
  if (R.stdin.isTTY) {
    controlContainer.controller = new TtyController({
      waitOverlayMessage: "Waiting for agent to finish",
      waitSuppressOutput: true,
      stdin: R.stdin,
      stdout: R.stdout,
      prompt: String(args["banner"] ?? "user: "),
      interjectKey: String(args["interject-key"] ?? "i"),
      interjectBanner: String(args["banner"] ?? "user: "),
      finalizer: async () => { await finalizeOnce(scheduler, projectDir, reviewMode); },
    });
  } else {
    new Passthrough({
      stdin: R.stdin,
      stdout: R.stdout,
      scheduler,
      finalizer: async () => { await finalizeOnce(scheduler, projectDir, reviewMode); },
    });
  }

  controlContainer.controller?.setScheduler(scheduler);
  await controlContainer.controller?.start();

  // Seed a kickoff message if provided
  if (typeof kickoff === "string" && kickoff.length > 0) {
    await scheduler.enqueueUserText(kickoff);
  }

  // Run the loop; normal finalize path
  await scheduler.start();

  const reviewManager = new ReviewManager(projectDir, reviewMode);
  await reviewManager.finalizeAndReview();
  await finalizeOnce(scheduler, projectDir, reviewMode);
  R.exit(0);
}

main().catch((e) => {
  Logger.info(e);
  R.exit(1);
});
