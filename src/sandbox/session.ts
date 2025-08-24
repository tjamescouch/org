// src/sandbox/session.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { ExecPolicy, ExecSpec, defaultPolicy, toSpec } from "./policy";
import { detectBackend, SandboxBackend } from "./detect";
import { ISandboxSession } from "./types";
import { PodmanSession } from "./backends/podman";
import { MockSession } from "./backends/mock";

export interface SessionManagerOptions {
  backend?: SandboxBackend | "auto";
}

export class SandboxManager {
  private sessions = new Map<string, ISandboxSession>();

  constructor(private projectDir: string, private runRoot?: string, private opts: SessionManagerOptions = { backend: "auto" }) {}

  async getOrCreate(id: string, policyOverrides: Partial<ExecPolicy> = {}) {
    let s = this.sessions.get(id);
    if (s) return s;

    const pol = defaultPolicy({
      projectDir: this.projectDir,
      runRoot: this.runRoot,
      image: policyOverrides.image,
      net: policyOverrides.net,
      limits: policyOverrides.limits,
      write: policyOverrides.write,
      keepScratch: policyOverrides.keepScratch,
    });
    const spec: ExecSpec = toSpec(pol);

    const backend = this.opts.backend === "auto" || !this.opts.backend ? detectBackend() : this.opts.backend;

    let sess: ISandboxSession;
    if (backend === "podman") {
      await this.ensureOrgStepScript(spec);
      sess = new PodmanSession(spec, {});
    } else {
      sess = new MockSession(spec);
    }

    await sess.start();
    this.sessions.set(id, sess);
    return sess;
  }

  async finalize(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const res = await s.finalize();
    await s.destroy();
    this.sessions.delete(id);
    return res;
  }

  private async ensureOrgStepScript(spec: ExecSpec) {
    const hostScriptSrc = path.resolve(process.cwd(), "scripts", "org-step.sh");
    if (!fs.existsSync(hostScriptSrc)) {
      throw new Error(`Missing scripts/org-step.sh; please add it and make it executable.`);
    }
    const dst = path.join(spec.workHostDir, ".org");
    await fsp.mkdir(dst, { recursive: true });
    await fsp.copyFile(hostScriptSrc, path.join(dst, "org-step.sh"));
    await fsp.chmod(path.join(dst, "org-step.sh"), 0o755);
  }
}
