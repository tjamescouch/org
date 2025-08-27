// src/sandbox/session.ts
import * as fsp from "fs/promises";
import * as path from "path";
import { ExecPolicy, ExecSpec, defaultPolicy, toSpec } from "./policy";
import { detectBackend, SandboxBackend } from "./detect";
import { ISandboxSession } from "./types";
import { PodmanSession } from "./backends/podman";
import { MockSession } from "./backends/mock";
import { spawn } from "node:child_process";
import { R } from "../runtime/runtime";
import { CONTAINER_NAME } from "../constants";

const DEFAULT_ORG_STEP_SH = `#!/usr/bin/env bash
set -euo pipefail
CMD="\${1:-}"
if [[ -z "\$CMD" ]]; then echo "usage: org-step.sh '<command>'" >&2; exit 2; fi
IDX="\${ORG_STEP_IDX:-0}"
OUT_DIR="\${ORG_OUT_DIR:-/work/.org/steps}"
TIMEOUT_MS="\${ORG_TIMEOUT_MS:-30000}"
STDOUT_MAX="\${ORG_STDOUT_MAX:-1048576}"
LIMIT_PIDS="\${ORG_PIDS_MAX:-128}"
cd /work || { echo "cannot cd to /work" >&2; exit 97; }
mkdir -p "\$OUT_DIR"
OUT_FILE="\$OUT_DIR/step-\$IDX.out"
ERR_FILE="\$OUT_DIR/step-\$IDX.err"
META_FILE="\$OUT_DIR/step-\$IDX.meta.json"
ulimit -u "\$LIMIT_PIDS" || true; ulimit -n 1024 || true
start_ts="$(date -Is)"
set +e
setsid bash -lc "\$CMD" >"\$OUT_FILE" 2>"\$ERR_FILE" &
pid="\$!"; wait "\$pid"; ec="\$?"
set -e
end_ts="$(date -Is)"
killedBy=""; [[ \$ec -eq 124 || \$ec -eq 137 ]] && killedBy="timeout"
for f in "\$OUT_FILE" "\$ERR_FILE"; do
  [[ -f "\$f" ]] || : > "\$f"
  size=$(stat -c%s "\$f" 2>/dev/null || stat -f%z "\$f"); if (( size > STDOUT_MAX )); then
    dd if="\$f" of="\$f.tmp" bs="\$STDOUT_MAX" count=1 status=none || true; mv "\$f.tmp" "\$f"
  fi
done
pgid="$(ps -o pgid= -p "\$pid" 2>/dev/null | tr -d ' ' || true)"
[[ -n "\$pgid" ]] && kill -TERM "-\$pgid" 2>/dev/null || true; sleep 0.1; kill -KILL "-\$pgid" 2>/dev/null || true
rm -rf /tmp/* 2>/dev/null || true
{
  echo '{'
  echo "  \"idx\": \$IDX,"
  printf '  "cmd": %s,\n' "$(printf '%s' "\$CMD" | (command -v jq >/dev/null && jq -Rs . || sed 's/"/\\"/g;s/^/"/;s/$/"/'))"
  printf '  "startedAt": %s,\n' "$(printf '%s' "\$start_ts" | (command -v jq >/dev/null && jq -Rs . || sed 's/"/\\"/g;s/^/"/;s/$/"/'))"
  printf '  "endedAt": %s,\n' "$(printf '%s' "\$end_ts"   | (command -v jq >/dev/null && jq -Rs . || sed 's/"/\\"/g;s/^/"/;s/$/"/'))"
  echo "  \"exitCode\": \$ec,"
  if [[ -n "\$killedBy" ]]; then echo "  \"killedBy\": \"\$killedBy\","; else echo "  \"killedBy\": null,"; fi
  echo "  \"stdoutPath\": \"\$OUT_FILE\","
  echo "  \"stderrPath\": \"\$ERR_FILE\""
  echo '}'
} > "\$META_FILE"
exit "\$ec"
`;

export interface SessionManagerOptions {
    backend?: SandboxBackend | "auto";
}

export class SandboxManager {
    private sessions = new Map<string, ISandboxSession>();

    constructor(private projectDir: string, private runRoot?: string, private opts: SessionManagerOptions = { backend: "auto" }) { }


    public async execInteractive(
        argv: string[],
        opts: {
            tty?: boolean;              // default true
            inheritStdio?: boolean;     // default true (let tmux control the terminal)
            env?: Record<string, string>;
            cwd?: string;
        } = {}
    ): Promise<{ exit: number; ok: boolean }> {
        const name =
            (this as any).containerName ??
            (this as any).containerId ??
            (typeof (this as any).ensureContainer === "function"
                ? await (this as any).ensureContainer()
                : null);

        if (!name) {
            throw new Error("PodmanSession: container name/id is not set (or ensureContainer failed).");
        }

        const podmanArgs: string[] = ["exec"];
        // tmux needs a real TTY. Make it opt-out (tty true by default).
        if (opts.tty !== false) podmanArgs.push("-it");
        if (opts.cwd) podmanArgs.push("--workdir", opts.cwd);

        for (const [k, v] of Object.entries(opts.env ?? {})) {
            podmanArgs.push("-e", `${k}=${v}`);
        }

        podmanArgs.push(name, ...argv);

        return await new Promise((resolve) => {
            const child = spawn("podman", podmanArgs, {
                stdio: opts.inheritStdio === false ? "pipe" : "inherit",
                env: R.env,
            });
            child.on("exit", (code) => resolve({ exit: code ?? 0, ok: (code ?? 0) === 0 }));
        });
    }



    async getOrCreate(id: string, policyOverrides: Partial<ExecPolicy> = {}) {
        console.log('getOrCreate', id, policyOverrides);

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


    async ensureOrgStepScript(spec: ExecSpec): Promise<string> {
        const dst = path.join(spec.workHostDir, ".org", "org-step.sh");
        await fsp.mkdir(path.dirname(dst), { recursive: true });

        // Resolution order:
        const envPath = R.env.ORG_STEP_SCRIPT;
        const candidates = [
            envPath && path.resolve(envPath),
            path.join(spec.projectDir, "scripts", "org-step.sh"),         // repo root
            path.join(__dirname, "../../scripts/org-step.sh"),            // installed package layout
        ].filter(Boolean) as string[];

        let srcContent: Buffer | null = null;
        for (const p of candidates) {
            try {
                const st = await fsp.stat(p);
                if (st.isFile()) { srcContent = await fsp.readFile(p); break; }
            } catch { }
        }
        if (!srcContent) srcContent = Buffer.from(DEFAULT_ORG_STEP_SH, "utf8");

        await fsp.writeFile(dst, srcContent, { mode: 0o755 });
        return dst;
    }
}


export const sandboxMangers = new Map<string, SandboxManager>();