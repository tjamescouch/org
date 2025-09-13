import * as path from "path";
import { Backend } from "./detect";
import { ExecPolicy } from "./policy";
import { LocalSession } from "./backends/local";

type ManagerOpts = {
  backend?: "auto" | Backend;
};

type ExecResult = { ok: boolean; exit: number; stdoutFile: string; stderrFile: string };

type SessionLike = {
  exec(cmd: string): Promise<ExecResult>;
  execInteractive?: (cmd: string) => any;
  getStepsHostDir?: () => string;
  finalize?: (key?: string) => void;
};

class SandboxManager {
  readonly projectDir: string;
  readonly runRoot: string;
  readonly opts: ManagerOpts;
  private sessions: Map<string, SessionLike> = new Map();

  constructor(projectDir: string, runRoot?: string, opts?: ManagerOpts) {
    this.projectDir = projectDir;
    this.runRoot = runRoot ?? path.join(projectDir, ".org");
    this.opts = opts ?? { backend: "auto" };
  }

  private createSessionFor(key: string): SessionLike {
    return new LocalSession(this.projectDir, key);
  }

  async getOrCreate(key: string, _policy?: Partial<ExecPolicy>): Promise<SessionLike> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const s = this.createSessionFor(key);
    this.sessions.set(key, s);
    return s;
  }

  finalize(key: string) {
    const s = this.sessions.get(key);
    try { s?.finalize?.(key); } catch {}
    this.sessions.delete(key);
  }
}

/** Global registry kept for compatibility with existing imports */
export const sandboxMangers: Map<string, SandboxManager> = new Map();

