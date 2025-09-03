/* tmux UI launcher — writes tmux.conf + inner runner with *separate* here-docs */

import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";
import { renderTmuxConf } from "./config";

/** Container vs host, left for future routing if needed. */
type Scope = "container" | "host";

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return (typeof v === "string" && v.length) ? v : fallback;
}

/** Stable paths inside the sandbox */
const WORK_DIR = "/work";
const ORG_DIR = `${WORK_DIR}/.org`;
const LOG_DIR = `${ORG_DIR}/logs`;
const TMUX_LOG_DIR = `${LOG_DIR}/tmux-logs`;
const TMUX_CONF = `${ORG_DIR}/tmux.conf`;
const TMUX_INNER = `${ORG_DIR}/tmux-inner.sh`;

/** Pick a tmux binary path (inside the sandbox image) */
function tmuxBin(): string {
  return env("ORG_TMUX_BIN", "/usr/bin/tmux");
}

/** Build the tiny runner that execs our console UI. */
function renderInnerRunner(entryCmd: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    // Keep tmux debug + app logs somewhere stable
    `mkdir -p "${LOG_DIR}" "${TMUX_LOG_DIR}"`,
    `APP_LOG="${LOG_DIR}/org-app-$(date -Is).log"`,
    "",
    // Environment capture is invaluable when debugging
    'echo "[tmux-inner] begin $(date -Is)" | tee -a "${APP_LOG}"',
    'stty -a 2>/dev/null | sed \'s/.*/[tmux-inner] stty: &/g\' | tee -a "${APP_LOG}" || true',
    'env | sort | sed \'s/.*/[tmux-inner] env: &/g\' | tee -a "${APP_LOG}" || true',
    "",
    // Prefer a stable bun path, but fall back sensibly
    'BUN="/usr/local/bin/bun"',
    'if ! command -v "$BUN" >/dev/null 2>&1; then',
    '  if command -v bun >/dev/null 2>&1; then',
    '    BUN="$(command -v bun)"',
    '  elif [ -x /home/ollama/.bun/bin/bun ]; then',
    '    BUN="/home/ollama/.bun/bin/bun"',
    '  elif [ -x /root/.bun/bin/bun ]; then',
    '    BUN="/root/.bun/bin/bun"',
    '  fi',
    'fi',
    "",
    // Be explicit about locale/term inside the pane
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "",
    `cd "${WORK_DIR}"`,
    "",
    // IMPORTANT: do not pipe the app; keep it attached to the pane’s TTY
    // If you need a transcript later, use util-linux `script` outside the exec.
    `exec ${entryCmd}`,
    "",
  ].join("\n");
}

/**
 * Launch the tmux based UI.
 *
 * This writes:
 *   - /work/.org/tmux.conf
 *   - /work/.org/tmux-inner.sh
 * …with *separate* here-docs (each EOF on a line by itself),
 * then starts tmux with that config.
 */
export async function launchTmuxUI(
  argv: string[] = [],
  scope: Scope = "container",
): Promise<number> {
  const projectDir = env("ORG_PROJECT_DIR", process.cwd());
  const agentSessionId = env("ORG_AGENT_SESSION_ID", "default");

  // What the inner runner should exec (let’s keep default aligned with your app)
  const entry = `${env("ORG_BUN_BIN", "/usr/local/bin/bun")} ${WORK_DIR}/src/app.ts --ui console`;

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // 1) doctor: tmux presence (interactive check because some backends require it)
  {
    const { code } = await shInteractive(
      ["bash", "-lc", "command -v tmux >/dev/null 2>&1"],
      { projectDir, agentSessionId },
    );
    Logger.info("[org/tmux] tmux check (interactive rc)", { code });
    if ((code ?? 127) !== 0) {
      throw new Error(
        "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox."
      );
    }
  }

  // 2) render the files we need
  const conf = renderTmuxConf({ defaultTerminal: "tmux-256color", addTrueColorOverrides: true });
  const inner = renderInnerRunner(entry);

  // 3) Write them with *separate* here-docs (EOF markers alone on their own lines)
  const writeFilesScript = [
    "set -Eeuo pipefail",
    `mkdir -p "${TMUX_LOG_DIR}"`,
    // tmux.conf
    `cat > "${TMUX_CONF}" <<'EOF_TMUX_CONF'`,
    conf,
    "EOF_TMUX_CONF",
    // tmux-inner.sh
    `cat > "${TMUX_INNER}" <<'EOF_INNER'`,
    inner,
    "EOF_INNER",
    `chmod +x "${TMUX_INNER}"`,
  ].join("\n");

  {
    const { code } = await shInteractive(
      ["bash", "-lc", writeFilesScript],
      { projectDir, agentSessionId },
    );
    if ((code ?? 1) !== 0) {
      throw new Error("[org/tmux] failed to write tmux files");
    }
  }

  // 4) Launch tmux pointing at our config, reusing a fixed socket/ session name.
  // Keep server logs under /work/.org/logs/tmux-logs (tmux will drop -vv logs there).
  const tmux = tmuxBin();
  const socketLabel = "tmux-0";
  const sessionName = "org";
  const tmuxCmd = [
    // Ensure tmux puts its socket and logs where we expect
    `export TMUX_TMPDIR="${TMUX_LOG_DIR}"`,
    // Start/attach the session using our config
    `exec ${tmux} -vv -L ${socketLabel} -f "${TMUX_CONF}" ` +
      `new-session -A -s ${sessionName} "${TMUX_INNER}"`,
  ].join("\n");

  Logger.info("[org/tmux] launching tmux", {
    tmux, socketLabel, conf: TMUX_CONF, inner: TMUX_INNER,
  });

  const { code } = await shInteractive(["bash", "-lc", tmuxCmd], {
    projectDir,
    agentSessionId,
  });

  Logger.info("[org/tmux] launcher end", { code });
  return code ?? 0;
}
