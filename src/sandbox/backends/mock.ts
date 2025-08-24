// src/sandbox/backends/mock.ts
// Safe mock: never touches Podman/Docker. Creates run artifacts only.
// Executes nothing; just records step files so tests pass deterministically.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ExecSpec } from "../policy";
import { ISandboxSession } from "../types";
import { initRunDirs, writeJsonPretty } from "../../replay/manifest";

export class MockSession implements ISandboxSession {
  private started = false;
  private stepIdx = 0;
  readonly runDir: string;

  constructor(private spec: ExecSpec) {
    this.runDir = spec.runDir;
  }

  async start() {
    if (this.started) return;
    await initRunDirs(this.runDir);
    await fsp.mkdir(this.spec.workHostDir, { recursive: true });
    // Create a minimal baseline marker
    await fsp.mkdir(path.join(this.spec.workHostDir, ".org", "steps"), { recursive: true });
    await fsp.writeFile(path.join(this.spec.workHostDir, ".org", "baseline.txt"), "mock-baseline\n", "utf8");
    this.started = true;
  }

  async exec(cmd: string) {
    if (!this.started) throw new Error("session not started");
    const idx = this.stepIdx++;
    const stepsDir = path.join(this.runDir, "steps");
    await fsp.mkdir(stepsDir, { recursive: true });

    const outPath = path.join(stepsDir, `step-${idx}.out`);
    const errPath = path.join(stepsDir, `step-${idx}.err`);
    const metaPath = path.join(stepsDir, `step-${idx}.meta.json`);

    // Deterministic "execution"
    const now = new Date();
    await fsp.writeFile(outPath, `MOCK: ${cmd}\n`, "utf8");
    await fsp.writeFile(errPath, "", "utf8");
    await fsp.writeFile(
      metaPath,
      JSON.stringify(
        {
          idx,
          cmd,
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          exitCode: 0,
          killedBy: null,
          stdoutPath: outPath,
          stderrPath: errPath,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    return { ok: true, exit: 0, stdoutFile: outPath, stderrFile: errPath };
  }

  async finalize() {
    // Emit an empty patch for consistency
    const patchPath = path.join(this.runDir, "session.patch");
    await fsp.writeFile(patchPath, "", "utf8");

    const manifestPath = path.join(this.runDir, "manifest.json");
    await writeJsonPretty(manifestPath, {
      spec: this.spec,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      container: { backend: "mock", name: "mock-session" },
      baselineCommit: "mock",
      exitSummary: { steps: this.stepIdx, lastExitCode: 0 },
      fullPatchRel: "session.patch",
      steps: [],
      artifacts: [],
      host: { platform: process.platform, release: os.release(), arch: process.arch },
    });

    return { manifestPath, patchPath };
  }

  async destroy(opts?: { removeScratch?: boolean }) {
    const remove = opts?.removeScratch ?? true;
    if (remove) {
      await fsp.rm(this.spec.workHostDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
