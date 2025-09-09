#!/usr/bin/env bun
// src/app.ts
//
// Vale note:
// - Runtime OWNS the single TtyController instance (R.ttyController).
// - Do NOT start the module-level singleton. Do NOT call finalize on startup.
// - ESC → controller.unwind() → finalizer (stop → drain → review/apply) → exit.
// - Scheduler drives work; controller renders prompts and handles hotkeys.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";


import { R } from "./runtime/runtime";
import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { C, Logger } from "./logger";
import RandomScheduler from "./scheduler/random-scheduler";
import type { IScheduler, SchedulerLike } from "./scheduler/scheduler";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { sandboxMangers } from "./sandbox/session";
import { TtyController } from "./input/tty-controller";
import Passthrough from "./input/passthrough";
import { createFeedbackController } from "./ui/feedback";
import { installHotkeys } from "./runtime/hotkeys";
import { printInitCard } from "./ui/pretty";

if (R.env.ORG_LAUNCHER_SCRIPT_RAN !== "1") { // TODO - safely support non-sandboxed workflows without opening up this hole.
  Logger.error(C.red("org must be launched via the org wrapper (sandbox). Refusing to run on host."));

  R.exit(112);
}

let paused = false;
export const setOutputPaused = (v: boolean) => {
  paused = v;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTY guard: the RUNTIME holds the controller instance (R.ttyController)
// ───────────────────────────────────────────────────────────────────────────────

let installed = false;
/** Hook signals; ensure finalizer runs once. */
export function installTtyGuard(): void {
  if (installed) return;
  installed = true;

  const unwind = () => {
    const c = R.ttyController;
    if (!c) return;
    c.unwind?.()
  };

  R.on("SIGINT", () => { unwind(); Logger.error?.("SIGINT"); R.exit(130); });
  R.on("SIGTERM", () => { unwind(); Logger.error?.("SIGTERM"); R.exit(143); });
  R.on("uncaughtException", (err) => { unwind(); Logger.error?.(err); R.exit(1); });
  R.on("unhandledRejection", (reason: unknown) => { unwind(); Logger.error?.(reason); R.exit(1); });
}

installTtyGuard();
Logger.info("[org] Installing hotkeys 🔥");
const uninstallHotkeys = installHotkeys({
  stdin: R.stdin as any,
  onEsc: async () => { await R.ttyController?.unwind(); /* finalizer handles review+exit */ },
  onCtrlC: () => { Logger.error("SIGINT"); R.exit(130); },
  feedback: R.stderr,
  debug: !!R.env.DEBUG,
});

/** Scoped helpers that return promises (safe to `await`). */
export async function withCookedTTY<T>(f: () => Promise<T> | T): Promise<T> {
  const ctl = R.ttyController;
  if (!ctl) return await Promise.resolve(f());
  return ctl.withCookedTTY(f);
}
export async function withRawTTY<T>(f: () => Promise<T> | T): Promise<T> {
  const ctl = R.ttyController;
  if (!ctl) return await Promise.resolve(f());
  return ctl.withRawTTY(f);
}


function assertIsRepository(p: string): string {
  let d = path.resolve(p);
  if (fs.existsSync(path.join(d, ".git"))) return d;

  Logger.error(`Not git repository at: ${p} (${d})`);

  throw new Error(`Not a git repository.`);
}

function resolvePath(p: string): string {
  return path.resolve(p);
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

// ───────────────────────────────────────────────────────────────────────────────
// Agent parsing
// ───────────────────────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────────────────────
// Review helpers (pager + apply)
// ───────────────────────────────────────────────────────────────────────────────

async function listRecentSessionPatches(workDir: string, minutes = 20): Promise<string[]> {
  const root = path.join(workDir, ".org", "runs");
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

function applyPatch(workDir: string, patchPath: string) {
  execFileSync("git", ["-C", workDir, "apply", "--index", patchPath], { stdio: "inherit" });
}

async function finalizeOnce(scheduler: SchedulerLike | null, workDir: string, reviewMode: "ask" | "auto" | "never") {
  // Ensure tools/sandboxes are finalized before we exit
  try { await (sandboxMangers as { finalizeAll?: () => Promise<void> }).finalizeAll?.(); } catch { /* ignore */ }
  try { await scheduler?.stop?.(); } catch { /* ignore */ }
  try { await scheduler?.drain?.(); } catch { /* ignore */ }

  const patches = await listRecentSessionPatches(workDir, 120);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }

  for (const patch of patches) {
    Logger.info(`Patch ready: ${patch}`);
    if (reviewMode === "never") continue;

    if (reviewMode === "auto" || !R.stdout.isTTY) {
      try { applyPatch(workDir, patch); Logger.info("Patch auto-applied."); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); Logger.error("Auto-apply failed:", msg); Logger.info(`You can apply manually: git -C ${workDir} apply --index ${patch}`); }
      continue;
    }

    await openPager(patch);
    const yes = await askYesNo("Apply this patch? [y/N]");
    if (yes) {
      try { applyPatch(workDir, patch); Logger.info("Patch applied."); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); Logger.error("Apply failed:", msg); Logger.info(`You can apply manually: git -C ${workDir} apply --index ${patch}`); }
    } else {
      Logger.info("Patch NOT applied.");
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// main
// ───────────────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const argv = R.argv.slice(2);
  const args = R.args;

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

  Logger.info(
    `${C.gray("Press ")}${C.bold("Esc")} ${C.gray("to gracefully exit (saves sandbox patches).")} ` +
    `${C.bold("Ctrl+C")} ${C.gray("for immediate exit.")}`
  );

  // Host starting directory (prefer an explicit host hint if provided).
  const hostStartDir =
    (typeof R.env.ORG_HOST_PWD === "string" && R.env.ORG_HOST_PWD.trim())
      ? path.resolve(R.env.ORG_HOST_PWD)
      : path.resolve((R.env.PWD && R.env.PWD.trim()) ? R.env.PWD : R.cwd());

  // Resolve repo root from that frozen starting directory.
  const projectDir = resolvePath('/project');
  const workDir = resolvePath('/work');

  // Pretty, TTY-aware banner (falls back to simple lines if not a TTY)
  printInitCard("org", [
    { label: "host cwd", value: C.bold(hostStartDir) },
    { label: "proj dir", value: C.bold(projectDir) },
    { label: "work dir", value: C.bold(workDir) },
    { label: "R.cwd", value: `${C.bold(R.cwd())}` },
    { label: "R.env.PWD", value: `${C.bold(R.env.PWD as string)}` },
  ]);

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
    agents, //FIXME - types
    maxTools: Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20))),
    onAskUser: async (_: string, content: string) => {
      // Open prompt, collect a single line, deliver it, then drain and exit.
      try {
        await R.ttyController?.askUser();
        const line = await R.ttyController!.readUserLine();
        await scheduler.interject(line);
        await scheduler.drain();
      } finally {
        if (!R.isPretty && !R.isTTY) {
          R.stdout.write("\n");
          R.exit(0);
        }
      }
    },
    workDir, // repo root to copy/sync into /work
    reviewMode,
    promptEnabled:
      typeof args["prompt"] === "boolean" ? (args["prompt"] as boolean)
        : kickoff ? false
          : R.stdin.isTTY,
    // Bridge: scheduler keeps the logic; controller renders & collects the line.
    readUserLine: async () => R.ttyController!.readUserLine(),
    // STREAM DEFERRAL: bracket every chattering section
    onStreamStart: async () => R.ttyController?.onStreamStart(),
    onStreamEnd: async () => R.ttyController?.onStreamEnd(),
  });

  // Build input (controller binds raw mode & keys; loop owned by scheduler)
  if (R.stdin.isTTY) {
    const feedback = createFeedbackController({
      spinner: true,
      pause: () => { setOutputPaused?.(true); /* or set a shared flag the LLM writer checks */ },
      resume: () => { setOutputPaused?.(false); },
    });

    R.ttyController = new TtyController({
      beginFeedback: feedback.begin,
      waitOverlayMessage: "Waiting for agent to finish",
      waitSuppressOutput: true,
      stdin: R.stdin,
      stdout: R.stdout,
      prompt: String(args["banner"] ?? "user: "),
      interjectKey: String(args["interject-key"] ?? "i"),
      interjectBanner: String(args["banner"] ?? "user: "),
      // ESC path ends up here: stop → drain → review/apply
      finalizer: async () => { await finalizeOnce(scheduler, workDir, reviewMode); },
      // Let the scheduler drive the idle loop
      loopMode: "external",
    });

    // Wire scheduler into THIS instance (the one that owns stdin)
    R.ttyController.setScheduler(scheduler);
    // Bind raw-mode & key handlers
    await R.ttyController.start();
  } else {
    // Non-interactive passthrough (no hotkeys)
    new Passthrough({
      stdin: R.stdin,
      stdout: R.stdout,
      scheduler,
      finalizer: async () => { await finalizeOnce(scheduler, workDir, reviewMode); },
    });
  }

  // Seed a kickoff message if provided
  if (typeof kickoff === "string" && kickoff.length > 0) {
    await scheduler.interject(kickoff);
  }

  // Start the scheduler loop. IMPORTANT: do NOT finalize here.
  await scheduler.start();

  // Keep the process alive via active listeners (TTY + scheduler loop).
  // Finalization happens via ESC (controller.finalizer) or signals (guard above).
}

main().catch(async (e) => {
  Logger.info(e);
  uninstallHotkeys();
  try { await R.ttyController?.unwind(); } catch { /* ignore */ }
  R.exit(1);
});
