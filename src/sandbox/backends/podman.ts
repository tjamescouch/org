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
import { ensureOk } from "../sh-result";
import { withCookedTTY } from "../../input/tty-controller";
import { collectRuntimeEnv } from "../../runtime/env-forward";
import { R } from "../../runtime/runtime";

const HARNESSED_APPLY_PATCH_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

: "\${ORG_PATCH_MAX_BYTES:=204800}"      # 200 KiB default
: "\${ORG_ALLOW_GLOBS:=*:**/*}"          # colon-separated globs
: "\${ORG_DENY_GLOBS:=.git/**:.org/**}"  # colon-separated globs
: "\${ORG_ALLOW_RENAMES:=0}"             # 1 to allow renames/mode changes
: "\${ORG_ALLOW_BINPATCH:=0}"            # 1 to allow "GIT binary patch"

PATCH_DIR="/work/.org/patches"
PATCH_FILE="\${PATCH_DIR}/incoming.patch"

mkdir -p "$PATCH_DIR"

# Read patch from stdin with a strict size cap
python3 - "\${ORG_PATCH_MAX_BYTES}" "$PATCH_FILE" <<'PY'
import sys
maxb=int(sys.argv[1]); dst=sys.argv[2]
data=sys.stdin.buffer.read(maxb+1)
if len(data)==0:
  sys.stderr.write("empty patch\\n"); sys.exit(2)
if len(data)>maxb:
  sys.stderr.write("patch too large\\n"); sys.exit(3)
open(dst,'wb').write(data)
PY

# Optional: disallow git binary patches
if [[ "\${ORG_ALLOW_BINPATCH}" != "1" ]] && grep -q "GIT binary patch" "$PATCH_FILE"; then
  echo "binary patches disabled" >&2; exit 4
fi

# Inspect (dry-run) what the patch would touch
NUMSTAT_SUMMARY="$(git -C /work apply --numstat --summary "$PATCH_FILE" 2>&1 || true)"
if [[ -z "$NUMSTAT_SUMMARY" ]]; then
  echo "git apply --numstat produced no output; invalid or empty patch" >&2; exit 5
fi

# Hygiene: block unsafe paths & mode/symlink/rename/delete unless allowed
if echo "$NUMSTAT_SUMMARY" | grep -Eq '(^|[[:space:]])(/|\\.{2}($|/)|\\.git/|\\.org/)' ; then
  echo "unsafe path in patch (absolute/.. or .git/.org)" >&2; exit 6
fi
if [[ "\${ORG_ALLOW_RENAMES}" != "1" ]] && echo "$NUMSTAT_SUMMARY" | grep -Eq '^(rename |.* mode |delete mode )'; then
  echo "renames/mode changes/deletes disabled" >&2; exit 7
fi
if echo "$NUMSTAT_SUMMARY" | grep -Eq 'mode 120000'; then
  echo "symlinks disabled" >&2; exit 8
fi

# Collect candidate paths
PATHS_JSON="$(python3 - <<'PY'
import sys,re,json
out=sys.stdin.read().splitlines()
paths=set()
for s in out:
  s=s.strip()
  m=re.match(r'^\\s*\\d+\\s+\\d+\\s+(.+)$', s)  # numstat path capture
  if m:
    paths.add(m.group(1).strip()); continue
  if s.startswith('rename ') or ' mode ' in s or s.startswith('create mode ') or s.startswith('delete mode '):
    parts=s.split()
    if parts:
      paths.add(parts[-1])
print(json.dumps(sorted(paths)))
PY
<<<"$NUMSTAT_SUMMARY")"

# Enforce policy globs (deny > allow)
python3 - "$PATHS_JSON" "\${ORG_DENY_GLOBS}" "\${ORG_ALLOW_GLOBS}" <<'PY'
import sys, json, fnmatch
paths=json.loads(sys.argv[1])
deny=[g for g in sys.argv[2].split(':') if g]
allow=[g for g in sys.argv[3].split(':') if g]
bad=[]
for p in paths:
  if any(fnmatch.fnmatch(p, g) for g in deny):
    bad.append(p); continue
  if allow and not any(fnmatch.fnmatch(p, g) for g in allow):
    bad.append(p)
if bad:
  sys.stderr.write("policy violation:\\n")
  for b in bad: sys.stderr.write(f"  {b}\\n")
  sys.exit(9)
PY

# Final check then apply to index (no worktree writes yet)
git -C /work apply --check "$PATCH_FILE"
git -C /work apply --index "$PATCH_FILE"
`;

const GIT_WRAPPER_SCRIPT = `#!/usr/bin/env bash
# Block direct 'git apply' to force policy path
if [[ "\${1:-}" == "apply" ]]; then
  echo "direct 'git apply' disabled; use apply_patch heredoc" >&2
  exit 111
fi
exec /usr/bin/git "$@"
`;

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

    getStepsHostDir(): string {
        return path.join(this.spec.workHostDir, ".org", "steps");
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
        const limits = [
            "--pids-limit", String(this.spec.limits.pidsMax),
            "--cpus", String(this.spec.limits.cpuCores),
            "--memory", `${this.spec.limits.memMiB}m`,
        ];
        const mounts = [
            "-v", `${this.spec.projectDir}:/project:ro`,
            "-v", `${this.spec.workHostDir}:/work:rw`,
        ];

        // Create container
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

        // Prime /work
        const prime = await this.execInCmd(
            "mkdir -p /work/.org && " +
            "rsync -a --delete " +
            "--exclude '.git/***' --exclude '.org/***' " +
            "--exclude 'org.bak*/***' --exclude 'org.bak.*/***' " +
            "--filter='P .org/' " +
            "/project/ /work/ && " +
            "mkdir -p /work/.org/steps"
        );
        if (prime.code !== 0) throw new Error(`sandbox prime failed: ${prime.stderr || prime.stdout}`);

        // Runner presence
        const hasRunner = await this.execInCmd("test -x /work/.org/org-step.sh");
        if (hasRunner.code !== 0) throw new Error("runner missing at /work/.org/org-step.sh");

        const hostOrgBin = path.join(this.spec.workHostDir, ".org", "bin");
        await fsp.mkdir(hostOrgBin, { recursive: true });

        // /work/.org/bin/apply_patch
        await fsp.writeFile(path.join(hostOrgBin, "apply_patch"), HARNESSED_APPLY_PATCH_SCRIPT, { mode: 0o755 });
        // /work/.org/bin/git
        await fsp.writeFile(path.join(hostOrgBin, "git"), GIT_WRAPPER_SCRIPT, { mode: 0o755 });

        // Init repo and baseline
        await this.must(this.execInCmd("git -C /work init"), "git init /work");
        await this.must(
            this.execInCmd("git -C /work config user.email noreply@example && git -C /work config user.name org"),
            "git config identity"
        );
        await this.execInCmd(
            "mkdir -p /work/.git/info && " +
            "printf '.org/\\norg.bak*/\\norg.bak.*/\\n*.rej\\n' >> /work/.git/info/exclude"
        );

        await this.must(
            this.execInCmd(
                "git -C /work add -A || true; " +
                "if git -C /work diff --cached --quiet 2>/dev/null; then " +
                "  git -C /work commit --allow-empty -m baseline >/dev/null 2>&1; " +
                "else " +
                "  git -C /work commit -m baseline >/dev/null 2>&1; " +
                "fi"
            ),
            "git baseline commit"
        );

        const rev = await this.must(this.execInCmd("git -C /work rev-parse --verify HEAD"), "git rev-parse HEAD");
        this.baselineCommit = rev.stdout.trim();
        await this.execInCmd("printf %s " + this.shQ(this.baselineCommit!) + " > /work/.org/baseline.txt");

        this.started = true;
    }

    // Always copy step artifacts; never return without creating meta/out/err.
    async exec(cmd: string): Promise<{ ok: boolean; exit: number; stdoutFile: string; stderrFile: string }> {
        if (!this.started) throw new Error("session not started");
        const idx = this.stepIdx++;

        await this.execInCmd("mkdir -p /work/.org/steps");

        // NOTE: Forward host env (process.env) through our safe collector so ad‑hoc
        // ORG_* vars like ORG_TEST are visible inside the container.
        const env: Record<string, string> = {
            ORG_STEP_IDX: String(idx),
            ORG_OUT_DIR: "/work/.org/steps",
            ORG_TIMEOUT_MS: String(this.spec.limits.timeoutMs),
            ORG_STDOUT_MAX: String(this.spec.limits.stdoutMax),
            ORG_PIDS_MAX: String(this.spec.limits.pidsMax),
            ...collectRuntimeEnv(R.env ?? process.env),
        };

        if ((R.env ?? process.env).ORG_DEBUG_ENV === "1") {
            Logger.info("env being sent to container:", Object.keys(env).filter(k => k.startsWith("ORG_")).sort().join(", "));
        }

        const run = await this.execInEnv(env, `/work/.org/org-step.sh ${this.shQ(cmd)}`);

        // Stage normal changes
        await this.execInCmd("git -C /work add -A");
        // Unstage .org
        await this.execInCmd("git -C /work reset -q .org || true");
        // Force-add ignored files (excluding internal/ephemeral)
        await this.execInCmd(
            "git -C /work ls-files -oi --exclude-standard -z | " +
            "grep -a -z -v -e '^\\.org/' -e '^\\.git/' -e '^org\\.bak' -e '\\.rej$' | " +
            "xargs -0 -r git -C /work add -f --"
        );
        // Commit if anything staged
        await this.execInCmd(
            "(git -C /work diff --cached --quiet || " +
            " git -C /work commit -m " + this.shQ(`step #${idx}: ${cmd}`) + " >/dev/null)"
        );

        const changedAll = (await this.execInCmd("git -C /work diff --name-only HEAD~1..HEAD || true")).stdout
            .split("\n").map((s) => s.trim()).filter(Boolean);

        const isEphemeral = (p: string) => p.startsWith("org.bak") || p.endsWith(".rej");
        const changed = changedAll.filter((p) => !isEphemeral(p));
        const violated = changed.filter((p) => !this.pathAllowed(p));

        // Persist step breadcrumbs to host
        const hostSteps = path.join(this.spec.runDir, "steps");
        await fsp.mkdir(hostSteps, { recursive: true }).catch(() => { });
        await fsp.writeFile(path.join(hostSteps, `step-${idx}.changed.txt`), changed.join("\n") + (changed.length ? "\n" : ""), "utf8").catch(() => { });
        const statusTxt = (await this.execInCmd("git -C /work diff --name-status HEAD~1..HEAD || true")).stdout;
        await fsp.writeFile(path.join(hostSteps, `step-${idx}.status.txt`), statusTxt, "utf8").catch(() => { });

        // Copy artifacts to host
        const hostOut = path.join(hostSteps, `step-${idx}.out`);
        const hostErr = path.join(hostSteps, `step-${idx}.err`);
        const hostMeta = path.join(hostSteps, `step-${idx}.meta.json`);

        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.out`, hostOut]); } catch (e) { Logger.error(e) }
        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.err`, hostErr]); } catch (e) { Logger.error(e) }
        let metaCopied = true;
        try { await this.execHost(["cp", `${this.name}:/work/.org/steps/step-${idx}.meta.json`, hostMeta]); } catch (e) { Logger.error(e); metaCopied = false; }

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

        if (violated.length > 0) {
            await this.execInCmd("git -C /work reset --hard HEAD~1 >/dev/null");
            await fsp.writeFile(path.join(hostSteps, `step-${idx}.violation.txt`), violated.join("\n") + "\n", "utf8");
            return { ok: false, exit: 3, stdoutFile: hostOut, stderrFile: hostErr };
        }

        return { ok: run.code === 0, exit: run.code, stdoutFile: hostOut, stderrFile: hostErr };
    }

    async finalize() {
        if (!this.started) throw new Error("session not started");

        await withCookedTTY(async () => {
            await this.execInCmd(
                "git -C /work " +
                "-c diff.noprefix=false " +
                "-c color.ui=false " +
                "-c core.pager=cat " +
                "diff --binary --no-ext-diff " + this.shQ(this.baselineCommit!) + " HEAD " +
                "> /work/.org/session.patch || true"
            );
        });

        const summary = await this.execInCmd("git -C /work diff --name-status " + this.shQ(this.baselineCommit!) + " HEAD");
        if (summary.stdout.trim()) {
            Logger.info("=== Accepted file changes ===");
            for (const line of summary.stdout.trim().split("\n")) Logger.info(line);
        } else {
            Logger.info("No accepted file changes.");
        }

        const stepDir = path.join(this.spec.runDir, "steps");
        const violations = (await fsp.readdir(stepDir)).filter((f) => f.endsWith(".violation.txt"));
        if (violations.length) {
            Logger.info("=== Rejected/violated files ===");
            for (const vf of violations) {
                const body = await fsp.readFile(path.join(stepDir, vf), "utf8");
                for (const line of body.trim().split("\n")) if (line) Logger.info(line);
            }
        }

        const patchDst = path.join(this.spec.runDir, "session.patch");
        await this.execHost(["cp", `${this.name}:/work/.org/session.patch`, patchDst]).catch(() => Promise.resolve());

        const newFiles = (await this.execInCmd(
            "git -C /work diff --name-status " + this.shQ(this.baselineCommit!) + " HEAD | awk '$1 ~ /^A|^AM$/ {print $2}'"
        )).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        for (const nf of newFiles) {
            const dst = path.join(this.spec.runDir, "artifacts", nf);
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await this.execHost(["cp", `${this.name}:/work/${nf}`, dst]).catch(() => Promise.resolve());
        }

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

        return {
            manifestPath,
            patchPath: fs.existsSync(patchDst) && fs.statSync(patchDst).size > 0 ? patchDst : undefined,
        };
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

    // Execute a command in the container at /work using bash -lc, capturing output.
    private async execInCmd(cmdline: string) {
        return sh(this.tool, ["exec", "--workdir", "/work", this.name, "bash", "-lc", cmdline]);
    }


    // Execute with env vars inside container, capturing output.
    private async execInEnv(env: Record<string, string>, cmdline: string) {
        const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
        Logger.info("envArgs", envArgs);
        return sh(this.tool, ["exec", "--workdir", "/work", ...envArgs, this.name, "bash", "-lc", cmdline]);
    }

    private shQ(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }

    private pathAllowed(p: string): boolean {
        const deny = this.spec.write.deny ?? [];
        if (deny.length && matchAny(deny, p)) {
            Logger.debug("Patch path denied: ", p);
            return false;
        }
        const allow = this.spec.write.allow ?? ["*", "**/*"];
        const result = matchAny(allow, p);
        Logger.debug(result ? "Patch path allowed: " : "Patch path denied: ", p);
        return result;
    }

    private async must<T extends { code?: number | null; stdout?: string; stderr?: string }>(
        rp: Promise<T>,
        context = "podman.exec"
    ): Promise<T> {
        const r = await rp;
        return ensureOk(r, context);
    }

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
