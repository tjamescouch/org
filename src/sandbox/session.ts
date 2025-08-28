import * as path from "path";
import { detectBackend, Backend } from "./detect";
import { ExecPolicy } from "./policy";
import { LocalSession } from "./backends/local";
import { PodmanSession } from "./backends/podman";

export type ManagerOpts = {
  backend?: "auto" | Backend;
};

type ExecResult = { ok: boolean; exit: number; stdoutFile: string; stderrFile: string };

type SessionLike = {
  exec(cmd: string): Promise<ExecResult>;
  execInteractive?: (cmd: string) => any;
  getStepsHostDir?: () => string;
  finalize?: (key?: string) => void;
};

function defaultImageTag(): string {
  // Allow override; otherwise match the Containerfile naming we've been using.
  // Keep this here to avoid importing any helper from podman.ts.
  return process.env.ORG_IMAGE?.trim() || "localhost/org-build:debian-12";
}

export class SandboxManager {
  readonly projectDir: string;
  readonly runRoot: string;
  readonly opts: ManagerOpts;
  private sessions: Map<string, SessionLike> = new Map();

  constructor(projectDir: string, runRoot?: string, opts?: ManagerOpts) {
    this.projectDir = projectDir;
    this.runRoot = runRoot ?? path.join(projectDir, ".org");
    this.opts = opts ?? { backend: "auto" };
  }

  private selectBackend(): Backend {
    const b = this.opts.backend ?? "auto";
    return b === "auto" ? detectBackend() : (b as Backend);
  }

  private createSessionFor(key: string): SessionLike {
    const backend = this.selectBackend();

    if (backend === "local") {
      return new LocalSession(this.projectDir, key);
    }

    if (backend === "podman") {
      // No sandboxImageTag import — compute default here.
      return new PodmanSession(defaultImageTag(), this.projectDir, key);
    }

    if (backend === "docker") {
      // If you later add a DockerSession, wire it here.
      // For now, local works well when already inside a container/VM.
      return new LocalSession(this.projectDir, key);
    }

    // Final fallback — never return a mock session silently.
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

