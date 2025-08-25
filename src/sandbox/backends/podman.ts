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
import { Logger } from "../../logger";

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
        const caps = ["--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges"];
        const limits = ["--pids-limit", String(this.spec.limits.pidsMax), "--cpus", String(this.spec.limits.cpuCores), "--memory", `${this.spec.limits.memMiB}m`];
        const mounts = [
            "-v", `${this.spec.projectDir}:/project:ro`,          // project is RO
            "-v", `${this.spec.workHostDir}:/work:rw`,             // scratch is RW (no :U; we use --userns=keep-id)
        ];

        // Create and start container.
        const create = await sh(this.tool, [
            "create",
            "--pull=never",
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
            "rsync -a --delete " +
            "--exclude '.git/***' --exclude '.org/***' " +   // don't copy repo's .org
            "--filter='P .org/' " +                           // don't delete dest .org
            "/project/ /work/ && " +
            "mkdir -p /work/.org/steps"
        );



        if (prime.code !== 0) throw new Error(`sandbox prime failed: ${prime.stderr || prime.stdout}`);

        // The runner must already be mounted under /work/.org by the host (ensureOrgStepScript).
        const hasRunner = await this.execInCmd("test -x /work/.org/org-step.sh");
        if (hasRunner.code !== 0) throw new Error("runner missing at /work/.org/org-step.sh");

        // after priming /work and mkdir -p /work/.org/steps
        await this.execInCmd(
            // Ignore sandbox internals in this working copy:
            "mkdir -p /work/.git/info && printf '.org/\\n' >> /work/.git/info/exclude"
        );

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

    // Always copy step artifacts; never return without creating meta/out/err.
    async exec(cmd: string): Promise<{ ok: boolean; exit: number; stdoutFile: string; stderrFile: string }> {
        if (!this.started) throw new Error("session not started");
        const idx = this.stepIdx++;

        // --- run the step (workdir=/work already enforced by helpers) ---
        await this.execInCmd("mkdir -p /work/.org/steps");
        const env: Record<string, string> = {
            ORG_STEP_IDX: String(idx),
            ORG_OUT_DIR: "/work/.org/steps",
            ORG_TIMEOUT_MS: String(this.spec.limits.timeoutMs),
            ORG_STDOUT_MAX: String(this.spec.limits.stdoutMax),
            ORG_PIDS_MAX: String(this.spec.limits.pidsMax),
        };
        const run = await this.execInEnv(env, `/work/.org/org-step.sh ${this.shQ(cmd)}`);

        // 1) stage normal changes
        await this.execInCmd("git -C /work add -A");

        // 2) explicitly unstage any .org/ (belt-and-suspenders)
        await this.execInCmd("git -C /work reset -q .org || true");

        // 3) force-add ignored files, but never anything under .org/ or .git/
        await this.execInCmd(
            "git -C /work ls-files -oi --exclude-standard -z | " +
            "grep -a -z -v -e '^\\.org/' -e '^\\.git/' | " +
            "xargs -0 -r git -C /work add -f --"
        );

        // 4) commit if there is anything staged
        await this.execInCmd(
            "(git -C /work diff --cached --quiet || " +
            " git -C /work commit -m " + this.shQ(`step #${idx}: ${cmd}`) + " >/dev/null)"
        );

        // (optional) breadcrumb for debugging
        await this.execInCmd(
            `git -C /work diff --name-only HEAD~1..HEAD > /work/.org/steps/step-${idx}.changed.txt || true`
        );


        // --- compute violations (but DO NOT return yet) ---
        const changed = (await this.execInCmd("git -C /work diff --name-only HEAD~1..HEAD || true")).stdout
            .split("\n").map(s => s.trim()).filter(Boolean);
        const violated = changed.filter(p => !this.pathAllowed(p));

        await this.execInCmd(`git -C /work diff --name-only HEAD~1..HEAD > /work/.org/steps/step-${idx}.changed.txt || true`);
        await this.execInCmd(`git -C /work diff --name-status HEAD~1..HEAD > /work/.org/steps/step-${idx}.status.txt || true`);

        // --- copy artifacts to host (best-effort; create placeholders if needed) ---
        const hostSteps = path.join(this.spec.runDir, "steps");
        await fsp.mkdir(hostSteps, { recursive: true }).catch(() => { });
        const hostOut = path.join(hostSteps, `step-${idx}.out`);
        const hostErr = path.join(hostSteps, `step-${idx}.err`);
        const hostMeta = path.join(hostSteps, `step-${idx}.meta.json`);

        // try to copy what the runner produced
        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.out`, hostOut]); } catch { }
        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.err`, hostErr]); } catch { }
        let metaCopied = true;
        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.meta.json`, hostMeta]); }
        catch { metaCopied = false; }

        // synthesize a tiny meta if copy failed (so the CLI always has a file)
        if (!metaCopied) {
            const now = new Date().toISOString();
            const meta = {
                idx,
                cmd,
                startedAt: now,
                endedAt: now,
                exitCode: run.code,
                killedBy: null,
                stdoutPath: `/work/.org/steps/step-${idx}.out`,
                stderrPath: `/work/.org/steps/step-${idx}.err`,
                note: "host-generated meta (copy failed or runner did not write meta)",
            };
            await fsp.writeFile(hostMeta, JSON.stringify(meta, null, 2), "utf8").catch(() => { });
        }

        // --- if violated, revert commit and record the violation file, but keep artifacts available ---
        if (violated.length > 0) {
            await this.execInCmd("git -C /work reset --hard HEAD~1 >/dev/null");
            await fsp.writeFile(path.join(hostSteps, `step-${idx}.violation.txt`), violated.join("\n") + "\n", "utf8");
            return { ok: false, exit: 3, stdoutFile: hostOut, stderrFile: hostErr };
        }

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
        await this.execHost(["rm", "-f", this.name]).catch(() => { });
        if (removeScratch) await fsp.rm(this.spec.workHostDir, { recursive: true, force: true }).catch(() => { });
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

    private pathAllowed(p: string) {
        const deny = this.spec.write.deny ?? [];
        if (deny.length && matchAny(deny, p)) {
            Logger.debug("Patch path denied: ", p);
            return false;     // deny takes precedence
        }

        const result = matchAny(this.spec.write.allow, p);

        if (result) {

        }
        Logger.debug(result ? "Patch path allowed: " : "Patch path denied: ", p);

        return result;
    }


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
