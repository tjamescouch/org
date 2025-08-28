import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";

// NOTE: older revs may NOT export sandboxImageTag; import the module as a namespace
import * as PodmanBackend from "../sandbox/backends/podman";
import type { PodmanSession } from "../sandbox/backends/podman";

export type ToolArgs   = { cmd: string };
export type ToolResult = { ok: boolean; stdout: string; stderr: string; exit_code: number; cmd: string };

export interface ToolCtx {
  projectDir: string;
  runRoot?: string;
  agentSessionId?: string;
  policy?: Partial<ExecPolicy>;
  logger?: { info: (...a: any[]) => void; error: (...a: any[]) => void };
  /** Heartbeat interval in ms while the command is idle (default 1000ms). */
  idleHeartbeatMs?: number;
}

let HEARTBEAT_MUTED = false;

export function setShHeartbeatMuted(muted: boolean) {
  HEARTBEAT_MUTED = muted;
}

/** Handy helper so callers can do: `await withMutedShHeartbeat(async () => { ... })` */
export async function withMutedShHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const prev = HEARTBEAT_MUTED;
  HEARTBEAT_MUTED = true;
  try { return await fn(); }
  finally { HEARTBEAT_MUTED = prev; }
}

/* -----------------------------------------------------------------------------
 * Sandbox manager lookup/creation (one per {projectDir, runRoot})
 * ---------------------------------------------------------------------------*/
async function getManager(key: string, projectDir: string, runRoot?: string) {
  let m = sandboxMangers.get(key);
  if (!m) {
    m = new SandboxManager(projectDir, runRoot, { backend: "auto" });
    sandboxMangers.set(key, m);
  }
  return m;
}

/** Determine the next step index by scanning existing `step-*` files. */
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
    } catch {
      // file not there yet
    }
    setTimeout(tick, pollMs);
  };

  tick();
  return { stop: () => { stopped = true; } };
}

/* -----------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------*/

/** Run a shell command inside the agent's sandbox with live streaming + heartbeat. */
export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? process.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");
  const idleHeartbeatMsRaw = ctx?.idleHeartbeatMs ?? 1000;
  const idleHeartbeatMs = HEARTBEAT_MUTED ? 0 : Math.max(250, idleHeartbeatMsRaw);

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
    if (idleHeartbeatMs > 0 && Date.now() - lastOutputAt >= idleHeartbeatMs) {
      process.stderr.write(".");
      printedHeartbeat = true;
    }
  }, Math.max(250, Math.floor(Math.max(1, idleHeartbeatMs) / 2)));

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
  const step = await session.exec(args.cmd);

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
  const out = fs.existsSync(step.stdoutFile)
    ? fs.readFileSync(step.stdoutFile, "utf8")
    : (fs.existsSync(liveOut) ? fs.readFileSync(liveOut, "utf8") : "");
  const err = fs.existsSync(step.stderrFile)
    ? fs.readFileSync(step.stderrFile, "utf8")
    : (fs.existsSync(liveErr) ? fs.readFileSync(liveErr, "utf8") : "");

  return { ok: step.ok, stdout: out, stderr: err, exit_code: step.exit, cmd: args.cmd };
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

/* -----------------------------------------------------------------------------
 * Podman convenience helpers (capture/interactive)
 * ---------------------------------------------------------------------------*/

/** Resolve the dev sandbox image tag across revisions without requiring a named export. */
function resolveSandboxImageTag(): string {
  const anyMod = PodmanBackend as any;
  const v = anyMod?.sandboxImageTag;

  if (typeof v === "function") {
    try { return v(); } catch { /* ignore */ }
  }
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  // Fallbacks (env first, then a conservative default)
  return (
    process.env.ORG_IMAGE ||
    process.env.SANDBOX_IMAGE ||
    process.env.ORG_SANDBOX_IMAGE ||
    "org-dev:latest"
  );
}

/** Internal: get a Podman session object for this (projectDir, sessionKey) pair */
function getPodman(projectDir: string, sessionKey: string): PodmanSession {
  const tag = resolveSandboxImageTag();
  // Use namespace import to be robust to export shape changes
  const Ctor = (PodmanBackend as any).PodmanSession as new (img: string, dir: string, key: string) => PodmanSession;
  return new Ctor(tag, projectDir, sessionKey);
}

/** Simple non-interactive capture. */
export async function shCapture(
  cmd: string,
  opts: { projectDir: string; agentSessionId: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const pod = getPodman(opts.projectDir, opts.agentSessionId);
  // Support older/newer method names
  const r: any = (pod as any).execCapture
    ? (pod as any).execCapture(cmd)
    : (pod as any).capture
      ? (pod as any).capture(cmd)
      : (() => ({ status: 127, stdout: "", stderr: "PodmanSession capture not implemented" }))();

  return { code: r.status ?? 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Interactive execution: attach TTY and inherit stdio. */
export async function shInteractive(
  cmdOrArgv: string | string[],
  opts: { projectDir: string; agentSessionId: string; }
): Promise<{ code: number }> {
  const cmd = Array.isArray(cmdOrArgv)
    ? cmdOrArgv.map(a => JSON.stringify(a)).join(" ")
    : cmdOrArgv;

  const pod = getPodman(opts.projectDir, opts.agentSessionId);
  const child: any = (pod as any).execInteractive
    ? (pod as any).execInteractive(cmd)
    : (pod as any).interactive
      ? (pod as any).interactive(cmd)
      : null;

  if (!child) return { code: 127 };

  return await new Promise<{ code: number }>((resolve) => {
    child.on("close", (code: number) => resolve({ code: code ?? 0 }));
    child.on("exit",  (code: number) => resolve({ code: code ?? 0 }));
    // If the spawn fails synchronously, Node throws — caller will see.
  });
}
