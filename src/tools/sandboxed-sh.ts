// src/tools/sandboxed-sh.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";

/* ------------------------------------------------------------------ *
 * Types & public surface
 * ------------------------------------------------------------------ */

type ToolArgs   = { cmd: string };
type ToolResult = { ok: boolean; stdout: string; stderr: string; exit_code: number; cmd: string };

export interface ToolCtx {
  projectDir: string;
  runRoot?: string;
  agentSessionId?: string;
  policy?: Partial<ExecPolicy>;
  logger?: { info: (...a: any[]) => void; error: (...a: any[]) => void };
  idleHeartbeatMs?: number; // default 1000ms
}

/** Result for capture/interactive convenience helpers. */
export type ShRunResult = { code: number; ok: boolean; out?: string; err?: string };

/* ------------------------------------------------------------------ *
 * Module state
 * ------------------------------------------------------------------ */

let HEARTBEAT_MUTED = false;
let LAST_SESSION_KEY: string | null = null;

/** External readers (e.g. UI) can ask which session was last used here. */
export function currentSandboxSessionKey(): string | null {
  return LAST_SESSION_KEY;
}

export function setShHeartbeatMuted(muted: boolean) {
  HEARTBEAT_MUTED = muted;
}

/** Handy helper so callers can do: await withMutedShHeartbeat(async () => { ... }) */
export async function withMutedShHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const prev = HEARTBEAT_MUTED;
  HEARTBEAT_MUTED = true;
  try { return await fn(); } finally { HEARTBEAT_MUTED = prev; }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

async function getManager(key: string, projectDir: string, runRoot?: string) {
  let m = sandboxMangers.get(key);
  if (!m) {
    m = new SandboxManager(projectDir, runRoot, { backend: "auto" });
    sandboxMangers.set(key, m);
  }
  return m;
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

/** Ensure session exists and return (manager, session). Also records LAST_SESSION_KEY. */
async function ensureSession(projectDir: string, agentSessionId: string, runRoot?: string) {
  LAST_SESSION_KEY = agentSessionId;
  const mgr = await getManager(agentSessionId, projectDir, runRoot);
  const session = await mgr.getOrCreate(agentSessionId);
  return { mgr, session };
}

/* ------------------------------------------------------------------ *
 * Primary tool: streamed shell with heartbeat (your existing behavior)
 * ------------------------------------------------------------------ */

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? process.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");
  const idleHeartbeatMsRaw = ctx?.idleHeartbeatMs ?? 1000;
  const idleHeartbeatMs = HEARTBEAT_MUTED ? 0 : Math.max(250, idleHeartbeatMsRaw);

  const { session } = await ensureSession(projectDir, sessionKey, runRoot);

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
  process.stderr.write(`sh: ${args.cmd} -> `);
  let lastOutputAt = Date.now();
  let printedHeartbeat = false;
  let brokeLineAfterHeartbeat = false;

  const breakHeartbeatLineOnce = () => {
    if (printedHeartbeat && !brokeLineAfterHeartbeat) {
      process.stderr.write("\n");
      brokeLineAfterHeartbeat = true;
    }
  };

  const hbTimer = setInterval(() => {
    if (Date.now() - lastOutputAt >= idleHeartbeatMs) {
      process.stderr.write(".");
      printedHeartbeat = true;
    }
  }, Math.max(250, Math.floor(idleHeartbeatMs / 2)));

  // Start tailers (they will wait until files appear)
  const outTail = tailFile(
    liveOut,
    (s) => { process.stdout.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); }
  );
  const errTail = tailFile(
    liveErr,
    (s) => { process.stderr.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); }
  );

  // Run the step inside the sandbox (this writes those files)
  const step = await (session as any).exec(args.cmd);

  // Stop heartbeat + tailers and clean up the line nicely.
  clearInterval(hbTimer);
  outTail.stop();
  errTail.stop();
  if (printedHeartbeat && !brokeLineAfterHeartbeat) process.stderr.write("\n");
  if (!printedHeartbeat && step.ok && !fs.existsSync(liveOut) && !fs.existsSync(liveErr)) {
    // nothing at all — still end the line
    process.stderr.write("\n");
  }

  // Read the final results from the step artifacts the way the rest of the system expects.
  const out = fs.existsSync(step.stdoutFile) ? fs.readFileSync(step.stdoutFile, "utf8") : "";
  const err = fs.existsSync(step.stderrFile) ? fs.readFileSync(step.stderrFile, "utf8") : "";

  return { ok: step.ok, stdout: out, stderr: err, exit_code: step.exit, cmd: args.cmd };
}

/* ------------------------------------------------------------------ *
 * Convenience helpers used by UI and tests
 * ------------------------------------------------------------------ */

/** Run a command in the sandbox and return stdout/stderr/exit code (no live streaming). */
export async function shCapture(
  cmd: string,
  opts: { projectDir: string; agentSessionId?: string; runRoot?: string }
): Promise<ShRunResult> {
  const sessionKey = opts.agentSessionId ?? "default";
  const { session } = await ensureSession(opts.projectDir, sessionKey, opts.runRoot);

  // Prefer a first-class capture if session implements one.
  if (typeof (session as any).execCapture === "function") {
    const r = await (session as any).execCapture(cmd);
    return { code: r.exit ?? r.code ?? 0, ok: !!r.ok, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  // Fallback: normal exec + read artifacts
  const r = await (session as any).exec(cmd);
  const out = fs.existsSync(r.stdoutFile) ? fs.readFileSync(r.stdoutFile, "utf8") : "";
  const err = fs.existsSync(r.stderrFile) ? fs.readFileSync(r.stderrFile, "utf8") : "";
  return { code: r.exit ?? 0, ok: !!r.ok, out, err };
}

/**
 * Run an interactive command in the sandbox, wiring stdio to the user's terminal.
 * Requires the sandbox session to support a TTY execution method.
 */
export async function shInteractive(
  cmd: string | string[],
  opts: {
    projectDir: string;
    agentSessionId?: string;
    runRoot?: string;
    tty?: boolean;
    inheritStdio?: boolean;
    env?: Record<string, string>;
    cwd?: string;
  }
): Promise<ShRunResult> {
  const sessionKey = opts.agentSessionId ?? "default";
  const { session } = await ensureSession(opts.projectDir, sessionKey, opts.runRoot);

  const argsArray = Array.isArray(cmd) ? cmd : ["bash", "-lc", cmd];

  if (typeof (session as any).execInteractive === "function") {
    const r = await (session as any).execInteractive(argsArray, {
      tty: !!opts.tty,
      inheritStdio: !!opts.inheritStdio,
      env: opts.env,
      cwd: opts.cwd,
    });
    return { code: r.exit ?? r.code ?? 0, ok: (r.exit ?? 0) === 0 };
  }

  // If the backend cannot create a TTY, give a helpful message.
  Logger.error(
    "Interactive execution is not supported by this sandbox session. " +
    "Your backend must provide a TTY-capable exec (e.g., `podman exec -it`)."
  );

  // Fallback: run without TTY so at least returns something.
  const r = await (session as any).exec(argsArray.join(" "));
  return { code: r.exit ?? 0, ok: !!r.ok };
}

/* ------------------------------------------------------------------ *
 * Finalizers & misc
 * ------------------------------------------------------------------ */

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
