import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SandboxManager } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";

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

const managers = new Map<string, SandboxManager>();

async function getManager(key: string, projectDir: string, runRoot?: string) {
  let m = managers.get(key);
  if (!m) {
    m = new SandboxManager(projectDir, runRoot, { backend: "auto" });
    managers.set(key, m);
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

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const sessionKey = ctx.agentSessionId ?? "default";
  const projectDir = ctx.projectDir ?? process.cwd();
  const runRoot    = ctx.runRoot ?? path.join(projectDir, ".org");
  const idleHeartbeatMs = Math.max(250, ctx.idleHeartbeatMs ?? 1000);

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
  const out = fs.existsSync(step.stdoutFile) ? fs.readFileSync(step.stdoutFile, "utf8") : "";
  const err = fs.existsSync(step.stderrFile) ? fs.readFileSync(step.stderrFile, "utf8") : "";

  return { ok: step.ok, stdout: out, stderr: err, exit_code: step.exit, cmd: args.cmd };
}

export async function finalizeSandbox(ctx: ToolCtx) {
  const sessionKey = ctx.agentSessionId ?? "default";
  Logger.info("Finalizing sandbox", sessionKey);
  const m = managers.get(sessionKey);
  if (!m) return;
  return m.finalize(sessionKey);
}

export async function finalizeAllSanboxes() {
  for (const [k, v] of Array.from(managers.entries())) v?.finalize(k);
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
