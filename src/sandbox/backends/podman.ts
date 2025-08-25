// src/sandbox/backends/podman.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { ExecSpec } from "../policy";
import { initRunDirs, writeJsonPretty, rel } from "../../replay/manifest";
import { matchAny } from "../glob";
import { ISandboxSession } from "../types";

type ShResult = { code: number; stdout: string; stderr: string };

function sh(cmd: string, args: string[]): Promise<ShResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", (d) => (so += String(d)));
    p.stderr.on("data", (d) => (se += String(d)));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: so, stderr: se }));
  });
}

export class PodmanSession implements ISandboxSession {
  private readonly tool = "podman" as const;
  private readonly name: string;
  private started = false;
  private stepIdx = 0;
  private baselineCommit?: string;
  readonly runDir: string;

  constructor(private spec: ExecSpec, _opts: { containerName?: string } = {}) {
    this.name = `org-${spec.id}`;
    this.runDir = spec.runDir;
  }

  // ---------- lifecycle ----------

  async start() {
    if (this.started) return;
    await initRunDirs(this.spec.runDir);
    await fsp.mkdir(this.spec.workHostDir, { recursive: true });

    const uid = (process.getuid && process.getuid()) || 1000;
    const gid = (process.getgid && process.getgid()) || 1000;

    const netArgs = this.spec.net.mode === "deny" ? ["--network=none"] : ["--network", "slirp4netns"];
    const caps    = ["--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges"];
    const limits  = ["--pids-limit", String(this.spec.limits.pidsMax), "--cpus", String(this.spec.limits.cpuCores), "--memory", `${this.spec.limits.memMiB}m`];
    const mounts  = [
      "-v", `${this.spec.projectDir}:/project:ro`,          // project is RO
      "-v", `${this.spec.workHostDir}:/work:rw`,             // scratch is RW (no :U; we use --userns=keep-id)
    ];

    // Create and start container.
    const create = await sh(this.tool, [
      "create",
      "--name", this.name,
      "--userns=keep-id", "--user", `${uid}:${gid}`,
      ...netArgs, ...caps, ...limits, ...mounts,
      this.spec.image,
      "sleep", "infinity",
    ]);
    if (create.code !== 0) throw new Error(`podman create failed: ${create.stderr || create.stdout}`);
    const start = await sh(this.tool, ["start", this.name]);
    if (start.code !== 0) throw new Error(`podman start failed: ${start.stderr || start.stdout}`);

    // Prime /work from /project; PROTECT .org/ from rsync --delete.
    const prime = await this.execInCmd(
      "mkdir -p /work/.org && " +
      "rsync -a --delete --exclude '.git' --filter='P .org/' /project/ /work/ && " +
      "mkdir -p /work/.org/steps"
    );
    if (prime.code !== 0) throw new Error(`sandbox prime failed: ${prime.stderr || prime.stdout}`);

    // The runner must already be mounted under /work/.org by the host (ensureOrgStepScript).
    const hasRunner = await this.execInCmd("test -x /work/.org/org-step.sh");
    if (hasRunner.code !== 0) throw new Error("runner missing at /work/.org/org-step.sh");

    // Baseline commit.
    await this.must(this.execInCmd("git -C /work init"));
    await this.must(this.execInCmd("git -C /work config user.email noreply@example && git -C /work config user.name org"));
    await this.must(this.execInCmd("git -C /work add -A && git -C /work commit -m baseline >/dev/null"));
    const rev = await this.execInCmd("git -C /work rev-parse HEAD");
    if (rev.code !== 0) throw new Error(`git baseline failed: ${rev.stderr || rev.stdout}`);
    this.baselineCommit = rev.stdout.trim();
    await this.execInCmd("printf %s " + this.shQ(this.baselineCommit!) + " > /work/.org/baseline.txt");

    this.started = true;
  }

  async exec(cmd: string) {
    if (!this.started) throw new Error("session not started");
    const idx = this.stepIdx++;

    // Run the step; all options BEFORE the container name, with workdir=/work.
    const env: Record<string, string> = {
      ORG_STEP_IDX: String(idx),
      ORG_OUT_DIR: "/work/.org/steps",
      ORG_TIMEOUT_MS: String(this.spec.limits.timeoutMs),
      ORG_STDOUT_MAX: String(this.spec.limits.stdoutMax),
      ORG_PIDS_MAX: String(this.spec.limits.pidsMax),
    };
    // Pre-create steps dir (belt & suspenders)
    await this.execInCmd("mkdir -p /work/.org/steps");

    const run = await this.execInEnv(env, `/work/.org/org-step.sh ${this.shQ(cmd)}`);

    // Commit changes if any
    await this.execInCmd(
      "git -C /work add -A && " +
      "(git -C /work diff --cached --quiet || git -C /work commit -m " + this.shQ(`step #${idx}: ${cmd}`) + " >/dev/null)"
    );

    // Enforce write allowlist on the last commit
    const changed = (await this.execInCmd("git -C /work diff --name-only HEAD~1..HEAD || true")).stdout
      .split("\n").map(s => s.trim()).filter(Boolean);
    const violated = changed.filter(p => !this.pathAllowed(p));
    if (violated.length > 0) {
      await this.execInCmd("git -C /work reset --hard HEAD~1 >/dev/null");
      await fsp.mkdir(path.join(this.spec.runDir, "steps"), { recursive: true });
      await fsp.writeFile(path.join(this.spec.runDir, "steps", `step-${idx}.violation.txt`), violated.join("\n") + "\n", "utf8");
      return {
        ok: false,
        exit: 3,
        stdoutFile: path.join(this.spec.runDir, "steps", `step-${idx}.out`),
        stderrFile: path.join(this.spec.runDir, "steps", `step-${idx}.err`),
      };
    }

    // Copy step outputs (best-effort)
    const hostSteps = path.join(this.spec.runDir, "steps");
    await fsp.mkdir(hostSteps, { recursive: true }).catch(() => {});
    const hostOut  = path.join(hostSteps, `step-${idx}.out`);
    const hostErr  = path.join(hostSteps, `step-${idx}.err`);
    const hostMeta = path.join(hostSteps, `step-${idx}.meta.json`);
    await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.out`, hostOut]).catch(() => {});
    await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.err`, hostErr]).catch(() => {});
    await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.meta.json`, hostMeta]).catch(() => {});

    return { ok: run.code === 0, exit: run.code, stdoutFile: hostOut, stderrFile: hostErr };
  }

  async finalize() {
    if (!this.started) throw new Error("session not started");

    await this.execInCmd("git -C /work diff --binary --no-prefix " + this.shQ(this.baselineCommit!) + " HEAD > /work/.org/session.patch || true");
    const patchDst = path.join(this.spec.runDir, "session.patch");
    await this.execHost(["cp", `${this.name}:/work/.org/session.patch`, patchDst]).catch(() => Promise.resolve());

    // Copy newly added files (artifacts)
    const newFiles = (await this.execInCmd("git -C /work diff --name-status " + this.shQ(this.baselineCommit!) + " HEAD | awk '$1 ~ /^A|^AM$/ {print $2}'")).stdout
      .split("\n").map(s => s.trim()).filter(Boolean);
    for (const nf of newFiles) {
      const dst = path.join(this.spec.runDir, "artifacts", nf);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await this.execHost(["cp", `${this.name}:/work/${nf}`, dst]).catch(() => Promise.resolve());
    }

    // Manifest
    const stepsMeta = await this.collectStepsMeta();
    const manifest = {
      spec: this.spec,
      startedAt: stepsMeta.length
        ? JSON.parse(await fsp.readFile(path.join(this.spec.runDir, "steps/step-0.meta.json"), "utf8")).startedAt
        : new Date().toISOString(),
      endedAt: new Date().toISOString(),
      container: { backend: "podman" as const, name: this.name },
      baselineCommit: this.baselineCommit,
      exitSummary: { steps: stepsMeta.length, lastExitCode: stepsMeta.length ? stepsMeta[stepsMeta.length - 1]!.exitCode : 0 },
      fullPatchRel: path.basename(patchDst),
      steps: stepsMeta,
      artifacts: [],
      host: { platform: process.platform, release: os.release(), arch: process.arch },
    };
    const manifestPath = path.join(this.spec.runDir, "manifest.json");
    await writeJsonPretty(manifestPath, manifest);

    return { manifestPath, patchPath: fs.existsSync(patchDst) && fs.statSync(patchDst).size > 0 ? patchDst : undefined };
  }

  async destroy({ removeScratch = true }: { removeScratch?: boolean } = {}) {
    await this.execHost(["rm", "-f", this.name]).catch(() => {});
    if (removeScratch) await fsp.rm(this.spec.workHostDir, { recursive: true, force: true }).catch(() => {});
  }

  // ---------- helpers ----------

  private async execHost(args: string[]) {
    const r = await sh(this.tool, args);
    if (r.code !== 0) throw new Error(`podman ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
  }

  private async execInCmd(cmdline: string) {
    return sh(this.tool, ["exec", "--workdir", "/work", this.name, "bash", "-lc", cmdline]);
  }

  private async execInEnv(env: Record<string, string>, cmdline: string) {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    return sh(this.tool, ["exec", "--workdir", "/work", ...envArgs, this.name, "bash", "-lc", cmdline]);
  }

  private shQ(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }

  private pathAllowed(p: string) { return matchAny(this.spec.write.allow, p); }

  private async must(rp: Promise<ShResult>) {
    const r = await rp; if (r.code !== 0) throw new Error(r.stderr || r.stdout); return r;
  }

  private async collectStepsMeta() {
    const dir = path.join(this.spec.runDir, "steps");
    const files = await fsp.readdir(dir).catch(() => []);
    const metas = files.filter(f => f.endsWith(".meta.json")).sort((a, b) => a.localeCompare(b));
    const out: any[] = [];
    for (const m of metas) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(dir, m), "utf8"));
        out.push({
          idx: j.idx,
          cmd: j.cmd,
          startedAt: j.startedAt,
          endedAt: j.endedAt,
          exitCode: j.exitCode,
          killedBy: j.killedBy ?? undefined,
          stdoutRel: rel(this.spec.runDir, path.join(dir, `step-${j.idx}.out`))!,
          stderrRel: rel(this.spec.runDir, path.join(dir, `step-${j.idx}.err`))!,
        });
      } catch { /* ignore */ }
    }
    return out;
  }
}
