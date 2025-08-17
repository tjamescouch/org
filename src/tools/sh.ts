import { ExecutionGate } from "./exec-gate";

/** ANSI helpers */
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** OpenAI "tools" schema for the sh command. */
export const SH_TOOL_DEF = {
  type: "function",
  function: {
    name: "sh",
    description: "Run a POSIX shell command and return machine-readable stdout/stderr/exit_code.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Full shell command, e.g. `ls -la`" }
      },
      required: ["cmd"],
      additionalProperties: false
    }
  }
};

/** Portable sleep */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>(res => setTimeout(res, ms));
}

/**
 * Run a shell command via "sh -c <cmd>" and capture stdout/stderr/exit.
 * - Portable: uses Bun.spawn when available, else Node's child_process.spawn.
 * - Prints in red: "sh: <cmd> -> <stdout|stderr merged>"
 * - Gated by ExecutionGate (confirmation when safe == true, plus guards).
 */
export async function runSh(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string; exit_code: number; cmd: string; }> {
  if (!(await ExecutionGate.check(cmd))) {
    const msg = `Execution denied by guard or user: ${cmd}`;
    console.log(red(`sh: ${cmd} -> ${msg}`));
    return { ok: false, stdout: "", stderr: msg, exit_code: 124, cmd };
  }

  // Bun path
  const bunAny: any = (globalThis as any).Bun;
  if (bunAny && typeof bunAny.spawn === "function") {
    const proc = bunAny.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const merged = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
    console.log(red(`sh: ${cmd} -> ${merged.trim()}`));
    return { ok: code === 0, stdout, stderr, exit_code: code, cmd };
  }

  // Node path
  const { spawn } = await import("child_process");
  const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const exit_code: number = await new Promise<number>((resolve) => {
    child.on("close", (code: number) => resolve(code ?? -1));
  });

  const merged = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
  console.log(red(`sh: ${cmd} -> ${merged.trim()}`));

  return { ok: exit_code === 0, stdout, stderr, exit_code, cmd };
}
