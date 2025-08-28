import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { SandboxManager, sandboxMangers } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";

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
 * Public API — non-interactive with heartbeat
 * ---------------------------------------------------------------------------*/

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? process.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");
  const idleHeartbeatMsRaw = ctx?.idleHeartbeatMs ?? 1000;
  const idleHeartbeatMs = HEARTBEAT_MUTED ? 0 : Math.max(250, idleHeartbeatMsRaw);

  const mgr = await getManager(sessionKey, projectDir, runRoot);
  const session = await mgr.getOrCreate(sessionKey, ctx.policy);

  const stepsHostDir: string =
    (typeof (session as any).getStepsHostDir === "function")
      ? (session as any).getStepsHostDir()
      : path.join(runRoot, "tmp", "unknown-steps"); // fallback

  const nextIdx   = await computeNextStepIdx(stepsHostDir);
  const liveOut   = path.join(stepsHostDir, `step-${nextIdx}.out`);
  const liveErr   = path.join(stepsHostDir, `step-${nextIdx}.err`);

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

  const step = await (session as any).exec(args.cmd);

  clearInterval(hbTimer);
  outTail.stop();
  errTail.stop();
  if (printedHeartbeat && !brokeLineAfterHeartbeat) process.stderr.write("\n");
  if (!printedHeartbeat && step.ok && !fs.existsSync(liveOut) && !fs.existsSync(liveErr)) {
    process.stderr.write("\n");
  }

  const out = fs.existsSync(step.stdoutFile) ? fs.readFileSync(step.stdoutFile, "utf8") : "";
  const err = fs.existsSync(step.stderrFile) ? fs.readFileSync(step.stderrFile, "utf8") : "";

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
 * Interactive helpers (session first; podman/docker fallback)
 * ---------------------------------------------------------------------------*/

export async function shCapture(
  cmd: string,
  opts: { projectDir: string; agentSessionId: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const mgr = await getManager(opts.agentSessionId, opts.projectDir);
  const session = await mgr.getOrCreate(opts.agentSessionId);
  const r = await (session as any).exec(cmd);
  const stdout = (r && r.stdoutFile && fs.existsSync(r.stdoutFile)) ? fs.readFileSync(r.stdoutFile, "utf8") : (r?.stdout ?? "");
  const stderr = (r && r.stderrFile && fs.existsSync(r.stderrFile)) ? fs.readFileSync(r.stderrFile, "utf8") : (r?.stderr ?? "");
  return { code: r?.exit ?? 0, stdout, stderr };
}

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

/** Interactive exec inside the sandbox. Preserves newlines / here-docs. */
export async function shInteractive(
  cmdOrArgv: string | string[],
  opts: { projectDir: string; agentSessionId: string; }
): Promise<{ code: number }> {
  // Preserve REAL newlines; do NOT JSON.stringify.
  let script: string;
  if (Array.isArray(cmdOrArgv)) {
    // Prefer raw shell script when caller uses ["bash","-lc", "<script>"]
    if (cmdOrArgv.length >= 2 && cmdOrArgv[0] === "bash" && cmdOrArgv[1] === "-lc") {
      script = cmdOrArgv.slice(2).join(" ");
    } else {
      // Best-effort for other shapes; assume caller handled quoting.
      script = cmdOrArgv.join(" ");
    }
  } else {
    script = cmdOrArgv;
  }

  const mgr = await getManager(opts.agentSessionId, opts.projectDir);
  const session = await mgr.getOrCreate(opts.agentSessionId);

  const runInteractive =
    (session && typeof (session as any).execInteractive === "function")
      ? (session as any).execInteractive.bind(session)
      : null;

  if (runInteractive) {
    const child = runInteractive(script);
    return await new Promise<{ code: number }>((resolve) => {
      child.on("close", (code: number | null) => resolve({ code: code ?? 0 }));
      child.on("exit",  (code: number | null) => resolve({ code: code ?? 0 }));
    });
  }

  // Fallback to container engine.
  const engine = findEngine();
  const cname  = getContainerName(session);
  if (!engine || !cname) {
    const keys = Object.keys(session ?? {}).sort();
    throw new Error(
      "[sandboxed-sh] Interactive exec is not supported by the current session backend, " +
      "and engine/container fallback was unavailable. " +
      `engine=${engine ?? "null"} container=${cname ?? "null"}; ` +
      `session keys: ${JSON.stringify(keys)}`
    );
  }

  const argv = ["exec", "-it", cname, "bash", "-lc", script];
  Logger.info(`[sandboxed-sh] fallback interactive via ${engine}: ${argv.join(" ")}`);

  const child = spawn(engine, argv, { stdio: "inherit" });
  return await new Promise<{ code: number }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0 }));
    child.on("exit",  (code) => resolve({ code: code ?? 0 }));
  });
}

