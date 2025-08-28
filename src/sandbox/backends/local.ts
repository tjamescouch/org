import { spawn } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

export type ExecResult = {
  ok: boolean;
  exit: number;
  stdoutFile: string; // host paths (same FS as the running process)
  stderrFile: string;
};

export class LocalSession {
  private projectDir: string;
  private sessionKey: string;

  constructor(projectDir: string, sessionKey: string) {
    this.projectDir = projectDir;
    this.sessionKey = sessionKey;
  }

  /** Host dir used for step artifacts */
  getStepsHostDir(): string {
    return path.join(this.projectDir, ".org", "steps");
  }

  private async ensureStepsDir(): Promise<void> {
    await fsp.mkdir(this.getStepsHostDir(), { recursive: true });
  }

  /** Non-interactive exec inside the *current* container/host namespace. */
  async exec(cmd: string): Promise<ExecResult> {
    await this.ensureStepsDir();
    const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const outH = path.join(this.getStepsHostDir(), `step-${stamp}.out`);
    const errH = path.join(this.getStepsHostDir(), `step-${stamp}.err`);

    const out = fs.createWriteStream(outH, { flags: "a" });
    const err = fs.createWriteStream(errH, { flags: "a" });

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", cmd], {
        cwd: this.projectDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (b: Buffer) => out.write(b));
      child.stderr.on("data", (b: Buffer) => err.write(b));

      const done = (code: number | null) => {
        try { out.end(); } catch {}
        try { err.end(); } catch {}
        const exit = code ?? 1;
        resolve({ ok: exit === 0, exit, stdoutFile: outH, stderrFile: errH });
      };

      child.on("error", () => done(1));
      child.on("close", (code) => done(code));
      child.on("exit",  (code) => done(code));
    });
  }

  /** Interactive exec (TTY inherits stdio). */
  execInteractive(cmd: string) {
    return spawn("bash", ["-lc", cmd], {
      cwd: this.projectDir,
      env: process.env,
      stdio: "inherit",
    });
  }

  finalize(): void {
    // nothing to do for local
  }
}

