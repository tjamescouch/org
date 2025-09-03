// src/tools/sandboxed-sh.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

interface StepsDirCarrier {
  getStepsHostDir?: () => string;
  stepsHostDir?: string;
  runRootHostDir?: string; // optional hint if available
}

/** Resolve a usable steps directory path even if the session lacks a helper. */
function resolveStepsHostDir(session: StepsDirCarrier, fallbackRoot?: string): string {
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
  return path.resolve(".org", "runs", "current", "steps");
}

type ToolArgs = { cmd: string };
export type ToolResult = { ok: boolean; stdout: string; stderr: string; exit_code: number; cmd: string };

interface ToolCtx {
  projectDir: string;
  runRoot?: string;
  agentSessionId?: string;
  policy?: Partial<ExecPolicy>;
  logger?: { info: (...a: any[]) => void; error: (...a: any[]) => void };
  idleHeartbeatMs?: number;
}

let HEARTBEAT_MUTED = false;
function setShHeartbeatMuted(muted: boolean) { HEARTBEAT_MUTED = muted; }
export async function withMutedShHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const prev = HEARTBEAT_MUTED; HEARTBEAT_MUTED = true;
  try { return await fn(); } finally { HEARTBEAT_MUTED = prev; }
}

/* utilities ---------------------------------------------------------------- */

function trace(...a: any[]) { if (R.env.DEBUG || R.env.ORG_TRACE) Logger.info("[sandboxed-sh]", ...a); }
function relIfInside(parent: string, child: string): string {
  const p = path.resolve(parent), c = path.resolve(child);
  if (c === p) return "";
  if (!c.startsWith(p + path.sep)) return "";
  return path.relative(p, c);
}

/* sandbox manager ---------------------------------------------------------- */
async function getManager(key: string, projectDir: string, runRoot?: string) {
  let m = sandboxMangers.get(key);
  if (!m) { m = new SandboxManager(projectDir, runRoot, { backend: "auto" }); sandboxMangers.set(key, m); }
  return m;
}

/* tail helpers (unchanged) ------------------------------------------------- */
// ... keep your existing tailFile/tailStepsDir from the previous file ...

/* -----------------------------------------------------------------------------
 * Public API — non-interactive with heartbeat + live streaming (unchanged)
 * ---------------------------------------------------------------------------*/

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  // keep your existing implementation here (unchanged from the previous file I sent)
  // …
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
  const prefix = cwdRel ? `cd ${JSON.stringify(cwdRel)} && ` : "";
  const fullCmd = `${prefix}${args.cmd}`;
  trace("exec command:", fullCmd);

  try { await fsp.mkdir(stepsHostDir, { recursive: true }); } catch {}

  R.stderr.write(`sh: ${args.cmd} -> `);
  let lastOutputAt = Date.now();
  let printedHeartbeat = false;
  let brokeLineAfterHeartbeat = false;
  const breakHeartbeatLineOnce = () => {
    if (printedHeartbeat && !brokeLineAfterHeartbeat) { R.stderr.write("\n"); brokeLineAfterHeartbeat = true; }
  };

  const hbTimer = setInterval(() => {
    if (idleHeartbeatMs > 0 && Date.now() - lastOutputAt >= idleHeartbeatMs) {
      R.stderr.write("."); printedHeartbeat = true;
    }
  }, Math.max(250, Math.floor(Math.max(1, idleHeartbeatMs) / 2)));

  const startMs = Date.now();
  const dirTail = tailStepsDir(
    stepsHostDir, startMs,
    (s) => { R.stdout.write(s); },
    (s) => { R.stderr.write(s); },
    () => { lastOutputAt = Date.now(); breakHeartbeatLineOnce(); },
    { pollMs: 150 }
  );

  const step = await (session as any).exec(fullCmd);

  clearInterval(hbTimer);
  dirTail.stop();
  if (printedHeartbeat && !brokeLineAfterHeartbeat) R.stderr.write("\n");

  try {
    const hasOut = step?.stdoutFile && fs.existsSync(step.stdoutFile);
    const hasErr = step?.stderrFile && fs.existsSync(step.stderrFile);
    if (!printedHeartbeat && step?.ok && !hasOut && !hasErr) R.stderr.write("\n");
  } catch {}

  const out = (step?.stdoutFile && fs.existsSync(step.stdoutFile)) ? fs.readFileSync(step.stdoutFile, "utf8") : (step?.stdout ?? "");
  const err = (step?.stderrFile && fs.existsSync(step.stderrFile)) ? fs.readFileSync(step.stderrFile, "utf8") : (step?.stderr ?? "");
  trace("exec end", { ok: !!step?.ok, exit: step?.exit ?? 0 });
  return { ok: !!step?.ok, stdout: out, stderr: err, exit_code: step?.exit ?? 0, cmd: args.cmd };
}

/* -----------------------------------------------------------------------------
 * Finalization helpers (unchanged)
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

function selectedSandboxBackend(): string {
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
 * Interactive helpers (tmux/inside-container first; engine fallback)
 * ---------------------------------------------------------------------------*/

function findEngine(): "podman" | "docker" | null {
  for (const e of ["podman", "docker"] as const) {
    try { const r = spawnSync(e, ["--version"], { stdio: "ignore" }); if (r.status === 0) return e; } catch {}
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

export async function shInteractive(
  cmdOrArgv: string | string[],
  opts: { projectDir: string; agentSessionId: string; }
): Promise<{ code: number }> {
  let script: string;
  if (Array.isArray(cmdOrArgv)) {
    if (cmdOrArgv.length >= 2 && cmdOrArgv[0] === "bash" && cmdOrArgv[1] === "-lc") {
      script = cmdOrArgv.slice(2).join(" ");
    } else {
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

  // Detailed logs to make failures actionable:
  Logger.debug("[shInteractive] begin", {
    inTmux: !!process.env.ORG_TMUX,
    insideContainer: process.env.ORG_SANDBOX_BACKEND === "none" || fs.existsSync("/run/.containerenv"),
    shell: process.env.SHELL || "/bin/sh",
    projectDir,
    userCwd,
    cwdRel,
    fullScript,
  });

  // Path A: already inside app container → run local /bin/sh -lc
  const insideContainer =
    process.env.ORG_SANDBOX_BACKEND === "none" ||
    fs.existsSync("/run/.containerenv");

  if (insideContainer) {
    Logger.debug("[shInteractive] running inside container via /bin/sh -lc");
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-lc", fullScript], { stdio: "inherit" });
    return await new Promise<{ code: number }>((resolve) => {
      child.on("close", (code) => resolve({ code: code ?? 0 }));
      child.on("exit",  (code) => resolve({ code: code ?? 0 }));
    });
  }

  // Path B: tmux UI present → send keys to pane
  if (process.env.ORG_TMUX === "1") {
    Logger.debug("[shInteractive] tmux send-keys path");
    const target = process.env.ORG_TMUX_SESSION ? `${process.env.ORG_TMUX_SESSION}:.` : ".";
    const sockArg = process.env.ORG_TMUX_SOCKET ? `-L ${shq(process.env.ORG_TMUX_SOCKET)}` : "";
    const tmuxCmd = `tmux ${sockArg} send-keys -t ${shq(target)} ${shq(fullScript)} C-m`;
    const r = spawnSync("/bin/sh", ["-lc", tmuxCmd], { stdio: "inherit" });
    return { code: r.status ?? 0 };
  }

  // Path C: backend-provided interactive
  const mgr = await getManager(opts.agentSessionId, projectDir, R.cwd());
  const session = await mgr.getOrCreate(opts.agentSessionId);
  const runInteractive =
    (session && typeof (session as any).execInteractive === "function")
      ? (session as any).execInteractive.bind(session)
      : null;

  if (runInteractive) {
    Logger.debug("[shInteractive] using session.execInteractive()");
    const child = runInteractive(fullScript);
    return await new Promise<{ code: number }>((resolve) => {
      child.on("close", (code: number | null) => resolve({ code: code ?? 0 }));
      child.on("exit",  (code: number | null) => resolve({ code: code ?? 0 }));
    });
  }

  // Path D: engine fallback (host) → /bin/sh -lc in container
  Logger.debug("[shInteractive] engine fallback path");
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

  const argv = ["exec", "-it", cname, "/bin/sh", "-lc", fullScript];
  Logger.info(`[sandboxed-sh] fallback interactive via ${engine}: ${argv.join(" ")}`);

  const child = spawn(engine, argv, { stdio: "inherit" });
  return await new Promise<{ code: number }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0 }));
    child.on("exit",  (code) => resolve({ code: code ?? 0 }));
  });
}

/* utils -------------------------------------------------------------------- */

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
