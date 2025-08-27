// src/tools/sandboxed-sh.ts
import { spawn } from "node:child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

// --- add near top (after imports)
let LAST_SESSION_KEY: string | null = null;

// Minimal shape we need from a session:
type ExecInteractiveOpts = {
  tty?: boolean;
  env?: Record<string, string>;
};
type SessionWithInteractive = {
  execInteractive?: (cmd: string, opts?: ExecInteractiveOpts) => Promise<number>;
};

type ToolArgs   = { cmd: string };
export type ToolResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  cmd: string;
};

export interface ToolCtx {
  projectDir: string;
  runRoot?: string;
  agentSessionId?: string;
  policy?: Partial<ExecPolicy>;
  logger?: { info: (...a: any[]) => void; error: (...a: any[]) => void };
  /** Heartbeat when a command is idle (ms). Default: 1000ms. Set to 0 to disable. */
  idleHeartbeatMs?: number;
}

let HEARTBEAT_MUTED = false;

export function setShHeartbeatMuted(muted: boolean) {
  HEARTBEAT_MUTED = muted;
}

// Handy helper so callers can do: await withMutedShHeartbeat(async () => { ... })
export async function withMutedShHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const prev = HEARTBEAT_MUTED;
  HEARTBEAT_MUTED = true;
  try { return await fn(); } finally { HEARTBEAT_MUTED = prev; }
}

async function getManager(key: string, projectDir: string, runRoot?: string) {
  let m = sandboxMangers.get(key);
  if (!m) {
    m = new SandboxManager(projectDir, runRoot, { backend: "auto" });
    sandboxMangers.set(key, m);
  }
  return m;
}


/** The most-recent sandbox session key used by any sh/shCapture/shInteractive call. */
export function currentSandboxSessionKey(): string | null {
  return LAST_SESSION_KEY;
}


/** Determine the next step index by scanning existing step-* files. */
async function computeNextStepIdx(stepsDir: string): Promise<number> {
  try {
    await fsp.mkdir(stepsDir, { recursive: true });
    const files = await fsp.readdir(stepsDir).catch(() => []);
    let max = -1;
    for (const f of files) {
      const m = /^step-(\d+)\./.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  } catch {
    return 0;
  }
}

/** Tail a file as it grows. Polling is robust across container/host boundaries. */
function tailFile(
  filePath: string,
  onChunk: (s: string) => void,
  onSeenOutput: () => void,
  opts?: { pollMs?: number }
) {
  let pos = 0;
  let stopped = false;
  const pollMs = Math.max(100, opts?.pollMs ?? 150);

  const tick = async () => {
    if (stopped) return;
    try {
      const st = await fsp.stat(filePath);
      if (st.size > pos) {
        await new Promise<void>((done, fail) => {
          const stream = fs.createReadStream(filePath, { start: pos, end: st.size - 1 });
          stream.on("data", (b: Buffer) => {
            onSeenOutput();
            onChunk(b.toString("utf8"));
          });
          stream.on("end", () => {
            pos = st.size;
            done();
          });
          stream.on("error", fail);
        });
      }
    } catch { /* file not there yet */ }
    setTimeout(tick, pollMs);
  };

  tick();
  return { stop: () => { stopped = true; } };
}

/**
 * Core sandboxed shell execution with streaming output and idle heartbeat.
 * This mirrors the UX you've already built and returns the canonical ToolResult.
 */
export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? R.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");
  const idleHeartbeatMsRaw = ctx?.idleHeartbeatMs ?? 1000;
  const idleHeartbeatMs = HEARTBEAT_MUTED ? 0 : Math.max(0, idleHeartbeatMsRaw);

  const mgr = await getManager(sessionKey, projectDir, runRoot);
  const session = await mgr.getOrCreate(sessionKey, ctx.policy);

  // Figure out the host path that mirrors /work/.org/steps inside the sandbox.
  // PodmanSession exposes getStepsHostDir(); fall back to a best effort if missing.
  const stepsHostDir: string =
    (typeof (session as any).getStepsHostDir === "function")
      ? (session as any).getStepsHostDir()
      : path.join(runRoot, "tmp", "unknown-steps"); // unlikely fallback

  // Predict the filenames this step will use; then set up live tail.
  const nextIdx   = await computeNextStepIdx(stepsHostDir);
  const liveOut   = path.join(stepsHostDir, `step-${nextIdx}.out`);
  const liveErr   = path.join(stepsHostDir, `step-${nextIdx}.err`);

  // Prefix + heartbeat (stderr), matching the local UX.
  R.stderr.write(`sh: ${args.cmd} -> `);
  let lastOutputAt = Date.now();
  let printedHeartbeat = false;
  let brokeLineAfterHeartbeat = false;

  const breakHeartbeatLineOnce = () => {
    if (printedHeartbeat && !brokeLineAfterHeartbeat) {
      R.stderr.write("\n");
      brokeLineAfterHeartbeat = true;
    }
  };

  const hbTimer = idleHeartbeatMs > 0
    ? setInterval(() => {
        if (Date.now() - lastOutputAt >= idleHeartbeatMs) {
          R.stderr.write(".");
          printedHeartbeat = true;
        }
      }, Math.max(250, Math.floor(idleHeartbeatMs / 2)))
    : undefined;

  // Start tailers (they will wait until files appear)
  const outTail = tailFile(
    liveOut,
    (s) => { R.stdout.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); }
  );
  const errTail = tailFile(
    liveErr,
    (s) => { R.stderr.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); }
  );

  // Run the step inside the sandbox (this writes those files)
  const step = await session.exec(args.cmd);

  // Stop heartbeat + tailers and clean up the line nicely.
  if (hbTimer) clearInterval(hbTimer);
  outTail.stop();
  errTail.stop();
  if (printedHeartbeat && !brokeLineAfterHeartbeat) R.stderr.write("\n");
  if (!printedHeartbeat && step.ok && !fs.existsSync(liveOut) && !fs.existsSync(liveErr)) {
    // nothing at all — still end the line
    R.stderr.write("\n");
  }

  // Read the final results from the step artifacts the way the rest of the system expects.
  const out = fs.existsSync(step.stdoutFile) ? fs.readFileSync(step.stdoutFile, "utf8") : "";
  const err = fs.existsSync(step.stderrFile) ? fs.readFileSync(step.stderrFile, "utf8") : "";

  return { ok: step.ok, stdout: out, stderr: err, exit_code: step.exit, cmd: args.cmd };
}

/**
 * Convenience: capture-only wrapper (no extra streaming logic beyond sandboxedSh).
 * Call signature mirrors tools in the codebase.
 */
export async function shCapture(arg: string | ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const a = typeof arg === "string" ? { cmd: arg } : arg;
  return sandboxedSh(a, ctx);
}

/**
 * Interactive TTY execution.
 * If the active sandbox implements `execInteractive(cmd, {stdio:"inherit"})`,
 * we use it to attach the caller's TTY. Otherwise we fall back to the
 * streaming/capture path and return its exit code.
 */
export async function shInteractive(arg: string | ToolArgs, ctx: ToolCtx): Promise<number> {
  const a = typeof arg === "string" ? { cmd: arg } : arg;

  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? R.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");

  const mgr = await getManager(sessionKey, projectDir, runRoot);
  const session = await mgr.getOrCreate(sessionKey, ctx.policy);

  // Prefer a real interactive attach if the backend supports it
  if (typeof (session as any).execInteractive === "function") {
    try {
      const res = await (session as any).execInteractive(a.cmd, { stdio: "inherit" });
      // Normalize possible shapes { exit } | number
      if (typeof res === "number") return res;
      if (res && typeof res.exit === "number") return res.exit;
      return 0;
    } catch {
      // Fall through to non-interactive on failure
    }
  }

  // Fallback: run with normal streaming and return the exit code.
  const r = await sandboxedSh(a, ctx);
  return r.exit_code;
}

export async function finalizeSandbox(ctx: ToolCtx) {
  const sessionKey = ctx.agentSessionId ?? "default";
  Logger.info("Finalizing sandbox", sessionKey);
  const m = sandboxMangers.get(sessionKey);
  if (!m) return;
  return m.finalize(sessionKey);
}

export async function finalizeAllSandboxes() {
  for (const [k, v] of Array.from(sandboxMangers.entries())) v?.finalize(k);
}

export function selectedSandboxBackend(): string {
  return detectBackend();
}

export const SANDBOXED_SH_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "sh",
    description:
      "Run a POSIX shell command inside a sandboxed session. " +
      "Streams output with heartbeat to the console, and returns JSON: { ok, stdout, stderr, exit_code, cmd }.",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string", description: "Command to run" } },
      required: ["cmd"],
    },
  },
} as const;



export async function shInteractive(
  cmd: string,
  ctx: ToolCtx & { env?: Record<string, string> } = { projectDir: R.cwd()}
): Promise<number> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? R.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");

  const mgr = await getManager(sessionKey, projectDir, runRoot);
  const session = (await mgr.getOrCreate(sessionKey, ctx.policy)) as unknown as SessionWithInteractive;

  // If the sandbox implements a real interactive exec (preferred)
  if (typeof session.execInteractive === "function") {
    // Ensure TERM is present for tmux
    const env = { TERM: R.env.TERM || "xterm-256color", ...(ctx.env || {}) };
    return await session.execInteractive(cmd, { tty: true, env });
  }

  // Fallback: run on host (no sandbox), still interactive
  const p = spawn("bash", ["-lc", cmd], {
    stdio: "inherit",
    env: { ...R.env, ...(ctx.env || {}), TERM: R.env.TERM || "xterm-256color" },
    cwd: projectDir,
  });
  return await new Promise<number>((resolve) => p.on("exit", (c) => resolve(c ?? 0)));
}
