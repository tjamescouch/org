// src/tools/sh.ts
import { ExecutionGate } from "./execution-gate";
import { C, Logger } from "../logger"; import { spawnInCleanEnvironment } from "../utils/spawn-clean";
import { R } from "../runtime/runtime";

export const SH_TOOL_DEF = {
  type: "function",
  function: {
    name: "sh",
    description:
      "Run a POSIX shell command in the current working directory. " +
      "Returns JSON: { ok, stdout, stderr, exit_code, cmd }.",
    parameters: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "The command to execute (e.g., 'ls -la | head -n 50').",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
} as const;

interface ShResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  cmd: string;
}


export async function runSh(
  cmd: string,
  opts?: {
    shell?: string;                 // default: /bin/bash if present, else /bin/sh
    cwd?: string;                   // default: R.cwd()
    env?: NodeJS.ProcessEnv;        // default: R.env
    idleHeartbeatMs?: number;       // default: 1000 (print '.' to stderr when idle)
  }
): Promise<ShResult> {

  Logger.debug("command:");
  Logger.debug(cmd)

  try {
    await ExecutionGate.gate(cmd);
  } catch (e) {
    const msg = `Execution denied by guard or user: ${cmd}`;
    Logger.info(C.red(`sh: ${cmd} -> ${msg}`));

    return { ok: false, stdout: '', stderr: `Execution denied by guard or user: ${cmd}`, exit_code: 10101, cmd };
  }

  const shell = opts?.shell ?? (R.platform === "win32" ? "bash" : "/bin/bash");
  const args = shell.endsWith("bash") || shell.endsWith("/bash") ? ["-lc", cmd] : ["-c", cmd];
  const cwd = opts?.cwd ?? R.cwd();
  const env = { ...R.env, ...(opts?.env ?? {}) };
  const idleHeartbeatMs = Math.max(250, opts?.idleHeartbeatMs ?? 1000);

  // UX line prefix as in your screenshots:
  // e.g. `sh: make -> make: Nothing to be done for 'all'.`
  // We write to stderr so it doesn't contaminate captured stdout.
  //R.stderr.write(`sh: ${cmd} -> `);

  return new Promise<ShResult>((resolve) => {
    const child = spawnInCleanEnvironment(shell, args, {
      cwd,
      env,
      timeoutMs: 10*60*1000,
      graceMs: 5000,
    });


    let out = "";
    let err = "";
    let exitCode: number | null = null;

    // Heartbeat state
    let lastChildOutputAt = Date.now(); // only updated by child output (not by heartbeat)
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let printedHeartbeat = false;
    let brokeLineAfterHeartbeat = false;

    const ensureHeartbeat = () => {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        const idleFor = Date.now() - lastChildOutputAt;
        if (idleFor >= idleHeartbeatMs && exitCode === null) {
          // print a dot on stderr to indicate we're alive
          R.stderr.write(C.bold("."));
          printedHeartbeat = true;
          // Note: DO NOT update lastChildOutputAt here — only child output resets idleness
        }
      }, Math.max(250, Math.floor(idleHeartbeatMs / 2)));
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    ensureHeartbeat();

    // Stream child output to the terminal while capturing it.
    child.stdout.on("data", (buf: Buffer) => {
      lastChildOutputAt = Date.now();
      const s = buf.toString("utf8");
      out += s;

      // If we were printing dots, break the line once before showing real output.
      if (printedHeartbeat && !brokeLineAfterHeartbeat) {
        R.stderr.write("\n");
        brokeLineAfterHeartbeat = true;
      }
      R.stdout.write(s);
    });

    child.stderr.on("data", (buf: Buffer) => {
      lastChildOutputAt = Date.now();
      const s = buf.toString("utf8");
      err += s;

      if (printedHeartbeat && !brokeLineAfterHeartbeat) {
        R.stderr.write("\n");
        brokeLineAfterHeartbeat = true;
      }
      R.stderr.write(s);
    });

    child.on("error", (e) => {
      clearHeartbeat();
      // Ensure we end the heartbeat line cleanly
      if (printedHeartbeat && !brokeLineAfterHeartbeat) R.stderr.write("\n");
      if (!printedHeartbeat) R.stderr.write("\n");

      resolve({
        ok: false,
        stdout: out,
        stderr: `${err}\n${String(e?.message ?? e)}`.trim(),
        exit_code: exitCode ?? 1,
        cmd,
      });
    });

    child.on("close", (code) => {
      exitCode = code ?? 0;
      clearHeartbeat();

      // Finish the line cleanly if we showed a heartbeat but no output followed.
      if (printedHeartbeat && !brokeLineAfterHeartbeat) R.stderr.write("\n");
      if (!printedHeartbeat && out.length === 0 && err.length === 0) {
        // no output at all — still end the line
        R.stderr.write("\n");
      }

      resolve({
        ok: exitCode === 0,
        stdout: out,
        stderr: err,
        exit_code: exitCode,
        cmd,
      });
    });
  });
}
