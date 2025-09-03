// src/ui/tmux/index.ts
/* tmux UI launcher — simple, robust, with strong instrumentation.
 *
 * This version:
 *   - Forces bash for inner script (avoids /bin/sh pipefail errors)
 *   - Writes /work/.org/tmux-inner.sh
 *   - Logs verbosely to /work/.org/logs/tmux-inner.*.log
 *   - Uses tmux -vv and TMUX_TMPDIR=/work/.org/logs/tmux-logs
 *   - Runs app with --ui console inside tmux so the outer `--ui tmux`
 *     doesn’t recurse.
 */

import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

function q(s: string) {
  return s.replace(/'/g, `'\\''`);
}

function innerScript(projectDir: string, entry: string) {
  // NOTE: keep this strictly bash; no template literal expansions inside the
  // HERE-DOC body other than the explicit ${...} we WANT expanded now.
  return `#!/usr/bin/env bash
set -Eeuo pipefail
set -x
umask 0002

PROJECT_DIR='${projectDir}'
ENTRY='${entry}'

LOG_DIR="\${PROJECT_DIR}/.org/logs"
TMUX_LOG_DIR="\${PROJECT_DIR}/.org/logs/tmux-logs"
mkdir -p "\${LOG_DIR}" "\${TMUX_LOG_DIR}" || true

INNER_LOG="\${LOG_DIR}/tmux-inner.$(date +%s).$$.log"
# Mirror all stdout/stderr into the log while still streaming to pane.
exec > >(tee -a "\${INNER_LOG}") 2>&1

echo "[inner] ===== tmux-inner start ====="
echo "[inner] date: $(date -Is)"
echo "[inner] whoami: $(whoami)"
echo "[inner] pwd(before cd): $(pwd)"
echo "[inner] SHELL=\${SHELL:-}"
echo "[inner] TERM=\${TERM:-}"
echo "[inner] env snapshot (trimmed):"
( env | LC_ALL=C sort ) | sed -E 's/(AUTH|TOKEN|SECRET|KEY)=.*/\\1=****/'

cd "\${PROJECT_DIR}"
echo "[inner] cd -> \${PROJECT_DIR}; pwd=$(pwd)"

# Resolve bun binary
BUN=""
for p in /usr/local/bin/bun /usr/bin/bun /home/ollama/.bun/bin/bun /root/.bun/bin/bun; do
  if [[ -x "$p" ]]; then BUN="$p"; break; fi
done
echo "[inner] bun resolved: \${BUN:-<none>}"
if [[ -z "\${BUN}" ]]; then
  echo "[inner] ERROR: bun not found on PATH or well-known locations"
  exit 127
fi
"\${BUN}" --version || true
command -v "\${BUN}" || true

# Final exec into the app (console UI INSIDE tmux)
echo "[inner] exec: \${BUN} \${ENTRY} --ui console"
exec "\${BUN}" "\${ENTRY}" --ui console
`;
}

/**
 * Launch the tmux UI inside the sandbox container.
 * We always run tmux in the sandbox via interactive exec.
 */
export async function launchTmuxUI(_argv: string[], _scope: Scope = "container"): Promise<number> {
  // Inside the app container the project root is /work; keep this explicit.
  const projectDir = process.env.ORG_PROJECT_DIR || "/work";
  const entry = "/work/src/app.ts";
  const logsDir = `${projectDir}/.org/logs`;
  const tmuxLogsDir = `${logsDir}/tmux-logs`;
  const innerPath = `${projectDir}/.org/tmux-inner.sh`;

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId: process.env.ORG_AGENT_SESSION_ID ?? "default",
    entry,
  });

  // Build a single interactive bash script that:
  //   - creates log dirs
  //   - writes the instrumented inner script
  //   - sets TMUX_TMPDIR
  //   - starts tmux with -vv and forces bash to run the inner script
  const script = [
    "set -Eeuo pipefail",
    "umask 0002",
    `mkdir -p '${q(tmuxLogsDir)}'`,
    `cat > '${q(innerPath)}' <<'EOS'`,
    innerScript(projectDir, entry),
    "EOS",
    `chmod +x '${q(innerPath)}'`,
    `export TMUX_TMPDIR='${q(tmuxLogsDir)}'`,
    // -vv for tmux server/client logs under TMUX_TMPDIR
    `/usr/bin/tmux -vv new-session -A -s org /usr/bin/env bash '${q(innerPath)}'`,
  ].join("\n");

  const { code } = await shInteractive(["bash", "-lc", script], {
    projectDir,
    agentSessionId: process.env.ORG_AGENT_SESSION_ID ?? "default",
  });

  return code ?? 0;
}
