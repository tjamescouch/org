import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

export interface StepsDirCarrier {
  getStepsHostDir?: () => string;
  stepsHostDir?: string;
  runRootHostDir?: string; // optional hint if available
}

/** Resolve a usable steps directory path even if the session lacks a helper. */
export function resolveStepsHostDir(session: StepsDirCarrier, fallbackRoot?: string): string {
  if (typeof session.getStepsHostDir === "function") {
    const p = session.getStepsHostDir();
    if (typeof p === "string" && p.length > 0) return p;
  }
  if (typeof session.stepsHostDir === "string" && session.stepsHostDir.length > 0) {
    return session.stepsHostDir;
  }
  if (typeof session.runRootHostDir === "string" && session.runRootHostDir.length > 0) {
    return path.join(session.runRootHostDir, "steps");
  }
  if (typeof fallbackRoot === "string" && fallbackRoot.length > 0) {
    return path.join(fallbackRoot, "steps");
  }
  // Last resort: a deterministic path under the CWD (keeps tests deterministic).
  return path.resolve(".org", "runs", "current", "steps");
}

export type ToolArgs = { cmd: string };
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
 * Small helpers
 * ---------------------------------------------------------------------------*/

function trace(...a: any[]) {
  if (R.env.DEBUG || R.env.ORG_TRACE) Logger.info("[sandboxed-sh]", ...a);
}

/** If `child` is inside `parent`, return the relative; otherwise return "" */
function relIfInside(parent: string, child: string): string {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return "";
  if (!c.startsWith(p + path.sep)) return "";
  return path.relative(p, c);
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

/** Tail any new step files created after `startMs` (handles stamp-based filenames). */
function tailStepsDir(
  stepsDir: string,
  startMs: number,
  onOut: (s: string) => void,
  onErr: (s: string) => void,
  onSeenOutput: () => void,
  opts?: { pollMs?: number }
) {
  const pollMs = Math.max(100, opts?.pollMs ?? 150);
  let stopped = false;

  const tracked = new Map<string, { stop: () => void; kind: "out" | "err" }>();
  const pattern = /^step-.*\.(out|err)$/;

  const attachTailer = async (fullPath: string, kind: "out" | "err") => {
    if (tracked.has(fullPath)) return;
    trace("attach tailer:", fullPath, kind);
    const t = tailFile(
      fullPath,
      (s) => (kind === "out" ? onOut(s) : onErr(s)),
      onSeenOutput,
      { pollMs }
    );
    tracked.set(fullPath, { stop: t.stop, kind });
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const names = await fsp.readdir(stepsDir).catch(() => []);
      for (const name of names) {
        if (!pattern.test(name)) continue;
        const full = path.join(stepsDir, name);
        if (tracked.has(full)) continue;
        try {
          const st = await fsp.stat(full);
          const recentEnough =
            st.mtimeMs >= startMs - 10 ||
            st.ctimeMs >= startMs - 10;
          if (recentEnough) {
            const kind: "out" | "err" = name.endsWith(".out") ? "out" : "err";
            await attachTailer(full, kind);
          }
        } catch {
          // ignore races
        }
      }
    } catch {
      // stepsDir may not exist yet
    }
    setTimeout(tick, pollMs);
  };

  trace("tail steps dir:", stepsDir);
  tick();
  return {
    stop: () => {
      stopped = true;
      for (const [, v] of tracked) {
        try { v.stop(); } catch { }
      }
      tracked.clear();
    }
  };
}

/* -----------------------------------------------------------------------------
 * Public API — non-interactive with heartbeat + live streaming
 * ---------------------------------------------------------------------------*/

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = path.resolve(ctx.projectDir ?? R.cwd());
  const runRoot = path.resolve(ctx.runRoot ?? path.join(projectDir, ".org"));
  const userCwd = path.resolve(R.cwd());
  const cwdRel = relIfInside(projectDir, userCwd);
  const idleHeartbeatMsRaw = ctx?.idleHeartbeatMs ?? 1000;
  const idleHeartbeatMs = HEARTBEAT_MUTED ? 0 : Math.max(250, idleHeartbeatMsRaw);

  trace("exec begin", { projectDir, runRoot, userCwd, cwdRel, cmd: args.cmd });

  const mgr = await getManager(sessionKey, projectDir, runRoot);
  const session = await mgr.getOrCreate(sessionKey, ctx.policy);

  const stepsHostDir = resolveStepsHostDir(session as unknown as StepsDirCarrier, runRoot);

  // Prefix the command with `cd <rel>` if we’re in a subdirectory of the project
  const prefix = cwdRel ? `cd ${JSON.stringify(cwdRel)} && ` : "";
  const fullCmd = `${prefix}${args.cmd}`;
  trace("exec command:", fullCmd);

  // Baseline: make sure the directory exists; streaming handler tolerates absence.
  try { await fsp.mkdir(stepsHostDir, { recursive: true }); } catch { }

  // Streaming banner + heartbeat
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

  const hbTimer = setInterval(() => {
    if (idleHeartbeatMs > 0 && Date.now() - lastOutputAt >= idleHeartbeatMs) {
      R.stderr.write(".");
      printedHeartbeat = true;
    }
  }, Math.max(250, Math.floor(Math.max(1, idleHeartbeatMs) / 2)));

  // Start a directory-wide streamer that will tail any new step-*.out/.err files
  const startMs = Date.now();
  const dirTail = tailStepsDir(
    stepsHostDir,
    startMs,
    (s) => { R.stdout.write(s); },
    (s) => { R.stderr.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); },
    { pollMs: 150 }
  );

  // Run the step inside the sandbox (this writes those files)
  const step = await (session as any).exec(fullCmd);

  // Stop heartbeat + streamers and clean up the line nicely.
  clearInterval(hbTimer);
  dirTail.stop();
  if (printedHeartbeat && !brokeLineAfterHeartbeat) R.stderr.write("\n");

  try {
    const hasOut = step?.stdoutFile && fs.existsSync(step.stdoutFile);
    const hasErr = step?.stderrFile && fs.existsSync(step.stderrFile);
    if (!printedHeartbeat && step?.ok && !hasOut && !hasErr) {
      R.stderr.write("\n");
    }
  } catch {
    // ignore
  }

  // Read the final results from the step artifacts the way the rest of the system expects.
  const out = (step?.stdoutFile && fs.existsSync(step.stdoutFile)) ? fs.readFileSync(step.stdoutFile, "utf8") : (step?.stdout ?? "");
  const err = (step?.stderrFile && fs.existsSync(step.stderrFile)) ? fs.readFileSync(step.stderrFile, "utf8") : (step?.stderr ?? "");

  trace("exec end", { ok: !!step?.ok, exit: step?.exit ?? 0 });
  return { ok: !!step?.ok, stdout: out, stderr: err, exit_code: step?.exit ?? 0, cmd: args.cmd };
}

/* -----------------------------------------------------------------------------
 * Finalization helpers
 * ---------------------------------------------------------------------------*/

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
 * Interactive helpers (session first; podman/docker fallback)
 * ---------------------------------------------------------------------------*/

export async function shCapture(
  cmd: string,
  opts: { projectDir: string; agentSessionId: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const projectDir = path.resolve(opts.projectDir);
  const userCwd = path.resolve(R.cwd());
  const cwdRel = relIfInside(projectDir, userCwd);
  const prefix = cwdRel ? `cd ${JSON.stringify(cwdRel)} && ` : "";
  const fullCmd = `${prefix}${cmd}`;
  trace("shCapture", { projectDir, userCwd, cwdRel, fullCmd });

  const mgr = await getManager(opts.agentSessionId, projectDir, R.cwd());
  const session = await mgr.getOrCreate(opts.agentSessionId);
  const r = await (session as any).exec(fullCmd);

  const stdout = (r && r.stdoutFile && fs.existsSync(r.stdoutFile)) ? fs.readFileSync(r.stdoutFile, "utf8") : (r?.stdout ?? "");
  const stderr = (r && r.stderrFile && fs.existsSync(r.stderrFile)) ? fs.readFileSync(r.stderrFile, "utf8") : (r?.stderr ?? "");
  return { code: r?.exit ?? 0, stdout, stderr };
}

function findEngine(): "podman" | "docker" | null {
  for (const e of ["podman", "docker"] as const) {
    try { const r = spawnSync(e, ["--version"], { stdio: "ignore" }); if (r.status === 0) return e; } catch { }
  }
  return null;
}

function getContainerName(session: any): string | null {
  const candidates = [
    "containerName", "ctrName", "name", "container", "id",
    ["backend", "containerName"],
    ["podman", "containerName"],
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const v = c.reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), session);
      if (typeof v === "string" && v.trim()) return v.trim();
    } else {
      const v = session?.[c];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Interactive exec inside the sandbox. Preserves newlines / here-docs. */
export async function shInteractive(
  cmdOrArgv: string | string[],
  opts: { projectDir: string; agentSessionId: string; }
): Promise<{ code: number }> {
  // Preserve REAL newlines; do NOT JSON.stringify.
  let script: string;
  if (Array.isArray(cmdOrArgv)) {
    if (cmdOrArgv.length >= 2 && cmdOrArgv[0] === "bash" && cmdOrArgv[1] === "-lc") {
      script = cmdOrArgv.slice(2).join(" ");
    } else {
      // Best-effort for other shapes; assume caller handled quoting.
      script = cmdOrArgv.join(" ");
    }
  } else {
    script = cmdOrArgv;
  }

  const projectDir = path.resolve(opts.projectDir);
  const userCwd = path.resolve(R.cwd());
  const cwdRel = relIfInside(projectDir, userCwd);
  const prefix = cwdRel ? `cd ${JSON.stringify(cwdRel)} && ` : "";
  const fullScript = `${prefix}${script}`;
  trace("shInteractive", { projectDir, userCwd, cwdRel, fullScript });

  const mgr = await getManager(opts.agentSessionId, projectDir, R.cwd());
  const session = await mgr.getOrCreate(opts.agentSessionId);

  const runInteractive =
    (session && typeof (session as any).execInteractive === "function")
      ? (session as any).execInteractive.bind(session)
      : null;

  if (runInteractive) {
    const child = runInteractive(fullScript);
    return await new Promise<{ code: number }>((resolve) => {
      child.on("close", (code: number | null) => resolve({ code: code ?? 0 }));
      child on("exit",  (code: number | null) => resolve({ code: code ?? 0 }));
    });
  }

  // Fallback to container engine.
  const engine = findEngine();
  const cname = getContainerName(session);
  if (!engine || !cname) {
    const keys = Object.keys(session ?? {}).sort();
    throw new Error(
      "[sandboxed-sh] Interactive exec is not supported by the current session backend, " +
      "and engine/container fallback was unavailable. " +
      `engine=${engine ?? "null"} container=${cname ?? "null"}; ` +
      `session keys: ${JSON.stringify(keys)}`
    );
  }

  const argv = ["exec", "-it", cname, "bash", "-lc", fullScript];
  Logger.info(`[sandboxed-sh] fallback interactive via ${engine}: ${argv.join(" ")}`);

  const child = spawn(engine, argv, { stdio: "inherit" });
  return await new Promise<{ code: number }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0 }));
    child.on("exit",  (code) => resolve({ code: code ?? 0 }));
  });
}
