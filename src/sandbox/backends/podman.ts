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

type Logger = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

    constructor(private spec: ExecSpec, private opts: { containerName?: string; logger?: Logger } = {}) {
        this.name = opts.containerName ?? `org-${spec.id}`;
        this.runDir = spec.runDir;
    }

    async start() {
        if (this.started) return;
        await initRunDirs(this.spec.runDir);
        await fsp.mkdir(this.spec.workHostDir, { recursive: true });

        const netArgs = this.spec.net.mode === "deny" ? ["--network=none"] : ["--network", "slirp4netns"];
        const caps = ["--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges"];
        const limits = ["--pids-limit", String(this.spec.limits.pidsMax), "--cpus", String(this.spec.limits.cpuCores), "--memory", `${this.spec.limits.memMiB}m`];
        const mounts = [
            "-v", `${this.spec.projectDir}:/project:ro,z`,
            "-v", `${this.spec.workHostDir}:/work:rw,z`,
        ];

        // NOTE: no "-w /work" here; Podman validates workdir before mounts exist.
        await this.execHost(this.tool, [
            "create", "--name", this.name,
            ...netArgs, ...caps, ...limits, ...mounts,
            this.spec.image, "sleep", "infinity",
        ]);
        await this.execHost(this.tool, ["start", this.name]);

        // Prime /work. Protect .org from deletion; then ensure steps dir exists.
        await this.execIn([
            "bash", "-lc",
            "mkdir -p /work/.org && " +
            "rsync -a --delete --exclude '.git' --exclude '.org/***' /project/ /work/ && " +
            "mkdir -p /work/.org/steps && " +
            "test -x /work/.org/org-step.sh || { echo 'missing /work/.org/org-step.sh'; exit 98; }"
        ]);

        // Baseline commit.
        await this.execIn(["bash", "-lc",
            "git -C /work init && " +
            "git -C /work config user.email noreply@example && " +
            "git -C /work config user.name org && " +
            "git -C /work add -A && git -C /work commit -m baseline >/dev/null"
        ]);
        const rev = await this.execIn(["bash", "-lc", "git -C /work rev-parse HEAD"]);
        this.baselineCommit = rev.stdout.trim();
        await this.execIn(["bash", "-lc", "printf %s " + this.shQ(this.baselineCommit!) + " > /work/.org/baseline.txt"]);

        this.started = true;
    }


    async exec(cmd: string): Promise<{ ok: boolean; exit: number; stdoutFile: string; stderrFile: string }> {
        if (!this.started) throw new Error("session not started");
        const idx = this.stepIdx++;
        const env = [
            "--env", `ORG_STEP_IDX=${idx}`,
            "--env", `ORG_OUT_DIR=/work/.org/steps`,
            "--env", `ORG_TIMEOUT_MS=${this.spec.limits.timeoutMs}`,
            "--env", `ORG_STDOUT_MAX=${this.spec.limits.stdoutMax}`,
            "--env", `ORG_PIDS_MAX=${this.spec.limits.pidsMax}`,
        ];

        // Run the runner from the writable mount.
        const r = await this.execIn([
            ...env,
            "bash", "-lc",
            `/work/.org/org-step.sh ${this.shQ(cmd)}`
        ]);

        // Commit changes (if any).
        await this.execIn([
            "bash", "-lc",
            "git -C /work add -A && (git -C /work diff --cached --quiet || git -C /work commit -m " +
            this.shQ(`step #${idx}: ${cmd}`) + " >/dev/null)"
        ]);

        // Enforce write allowlist for the last commit.
        const show = await this.execIn(["bash", "-lc", "git -C /work diff --name-only HEAD~1..HEAD || true"]);
        const changed = show.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        const violated = changed.filter((p) => !this.pathAllowed(p));
        if (violated.length > 0) {
            await this.execIn(["bash", "-lc", "git -C /work reset --hard HEAD~1 >/dev/null"]);
            await fsp.writeFile(path.join(this.spec.runDir, "steps", `step-${idx}.violation.txt`), violated.join("\n") + "\n", "utf8");
            return {
                ok: false, exit: 3,
                stdoutFile: path.join(this.spec.runDir, "steps", `step-${idx}.out`),
                stderrFile: path.join(this.spec.runDir, "steps", `step-${idx}.err`),
            };
        }

        // Copy step outputs if they exist (don’t throw if they don’t).
        const hostOut = path.join(this.spec.runDir, "steps", `step-${idx}.out`);
        const hostErr = path.join(this.spec.runDir, "steps", `step-${idx}.err`);
        const hostMeta = path.join(this.spec.runDir, "steps", `step-${idx}.meta.json`);

        try { await this.execHost(this.tool, ["cp", `${this.name}:/work/.org/steps/step-${idx}.out`, hostOut]); } catch { }
        try { await this.execHost(this.tool, ["cp", `${this.name}:/work/.org/steps/step-${idx}.err`, hostErr]); } catch { }
        try { await this.execHost(this.tool, ["cp", `${this.name}:/work/.org/steps/step-${idx}.meta.json`, hostMeta]); } catch { }

        return {
            ok: r.code === 0,
            exit: r.code,
            stdoutFile: hostOut,
            stderrFile: hostErr,
        };
    }


    async finalize() {
        if (!this.started) throw new Error("session not started");

        await this.execIn(["bash", "-lc", "git -C /work diff --binary --no-prefix " + this.shQ(this.baselineCommit!) + " HEAD > /work/.org/session.patch || true"]);

        const runPatch = path.join(this.spec.runDir, "session.patch");
        await this.execHost(this.tool, ["cp", `${this.name}:/work/.org/session.patch`, runPatch]).catch(() => Promise.resolve());

        // Copy newly added files (artifacts)
        const listNew = await this.execIn(["bash", "-lc", "git -C /work diff --name-status " + this.shQ(this.baselineCommit!) + " HEAD | awk '$1 ~ /^A|^AM$/ {print $2}'"]);
        const newFiles = listNew.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        for (const nf of newFiles) {
            const dst = path.join(this.spec.runDir, "artifacts", nf);
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await this.execHost(this.tool, ["cp", `${this.name}:/work/${nf}`, dst]).catch(() => Promise.resolve());
        }

        // Manifest
        const stepsMeta = await this.collectStepsMeta();
        const manifest = {
            spec: this.spec,
            startedAt: stepsMeta.length ? JSON.parse(await fsp.readFile(path.join(this.spec.runDir, "steps/step-0.meta.json"), "utf8")).startedAt : new Date().toISOString(),
            endedAt: new Date().toISOString(),
            container: { backend: "podman" as const, name: this.name },
            baselineCommit: this.baselineCommit,
            exitSummary: { steps: stepsMeta.length, lastExitCode: stepsMeta.length ? stepsMeta[stepsMeta.length - 1]!.exitCode : 0 },
            fullPatchRel: path.basename(runPatch),
            steps: stepsMeta,
            artifacts: [],
            host: { platform: process.platform, release: os.release(), arch: process.arch },
        };
        const manifestPath = path.join(this.spec.runDir, "manifest.json");
        await writeJsonPretty(manifestPath, manifest);

        return { manifestPath, patchPath: fs.existsSync(runPatch) && fs.statSync(runPatch).size > 0 ? runPatch : undefined };
    }

    async destroy({ removeScratch = true }: { removeScratch?: boolean } = {}) {
        await this.execHost(this.tool, ["rm", "-f", this.name]).catch(() => { });
        if (removeScratch) {
            await fsp.rm(this.spec.workHostDir, { recursive: true, force: true }).catch(() => { });
        }
    }

    // -- helpers --
    private async execHost(cmd: string, args: string[]) {
        const r = await sh(cmd, args);
        if (r.code !== 0) throw new Error(`podman ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
        return r;
    }
    private async execIn(args: string[]) { return sh(this.tool, ["exec", this.name, ...args]); }
    private shQ(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }
    private pathAllowed(p: string) { return matchAny(this.spec.write.allow, p); }

    private async collectStepsMeta() {
        const dir = path.join(this.spec.runDir, "steps");
        const files = await fsp.readdir(dir).catch(() => []);
        const metas = files.filter((f) => f.endsWith(".meta.json")).sort((a, b) => a.localeCompare(b));
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
