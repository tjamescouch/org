/* tmux UI launcher — instrumented for robust debugging */

import { Logger } from "../../logger";
import { shInteractive, shCapture } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

/**
 * Launch the tmux UI inside the sandbox (the app container).
 *
 * This version adds heavy instrumentation so we can see exactly why the pane
 * process exits. It:
 *  - Creates /work/.org/tmux-inner.sh with tracing + exit logging
 *  - Writes /work/.org/tmux.conf with remain-on-exit, exit-empty=off, etc.
 *  - Uses tmux -vv and a stable -L socket so logs always land in
 *    /work/.org/logs/tmux-logs/tmux-0/ (server + client logs).
 */
export async function launchTmuxUI(argv: string[], _scope: Scope = "container"): Promise<number> {
  // In our containerized layout, /work is the repo root.
  // We force this to avoid leaking the *host* path when the UI was launched
  // from a nested cwd (this was a source of earlier confusion).
  const projectDir = "/work";
  const agentSessionId = "default";
  const entry = "/work/src/app.ts";

  const LOG_DIR = "/work/.org/logs";
  const TMUX_LOG_DIR = `${LOG_DIR}/tmux-logs`;
  const RUN_LOG = `${LOG_DIR}/tmux-run.log`;
  const TMUX_SOCKET_NAME = "tmux-0";             // stable label for log placement
  const TMUX_CONF = "/work/.org/tmux.conf";
  const INNER = "/work/.org/tmux-inner.sh";

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // doctor: make sure tmux is available where we're about to run it
  const rc = await doctorTmux(projectDir, agentSessionId);
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc });
  if (rc !== 0) {
    throw new Error("tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.");
  }

  // One interactive script that:
  //  1) Makes log dirs
  //  2) Writes tmux-inner.sh (logs start/exit, finds bun, execs org --ui console)
  //  3) Writes tmux.conf with remain-on-exit etc.
  //  4) Starts a new-session with -vv and attaches; we annotate attach rc.
  const script = [
    "set -Eeuo pipefail",
    `mkdir -p ${TMUX_LOG_DIR} ${LOG_DIR}`,
    `echo "[tmux/launcher] begin $(date -Is)" >> ${RUN_LOG}`,

    // Inner runner — logs start/exit so we know if the pane process crashes
    `cat > ${INNER} <<'EOS'`,
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    `RUN_LOG="${RUN_LOG}"`,
    `echo "[tmux-inner] start $(date -Is)" >> "$RUN_LOG"`,
    "",
    // Keep TERM sane
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "",
    // Resolve bun robustly
    'BUN="/usr/local/bin/bun"',
    'if ! command -v "$BUN" >/dev/null 2>&1; then',
    '  if command -v bun >/dev/null 2>&1; then',
    '    BUN="$(command -v bun)"',
    "  elif [ -x /home/ollama/.bun/bin/bun ]; then",
    '    BUN="/home/ollama/.bun/bin/bun"',
    "  elif [ -x /root/.bun/bin/bun ]; then",
    '    BUN="/root/.bun/bin/bun"',
    "  fi",
    "fi",
    'if [ -z "${BUN:-}" ] || [ ! -x "$BUN" ]; then',
    '  echo "[tmux-inner] bun not found" >> "$RUN_LOG"',
    "  exit 127",
    "fi",
    "",
    // Always run from /work
    "cd /work",
    // Exit tracer
    'trap \'ec=$?; echo "[tmux-inner] exit ${ec} $(date -Is)" >> "$RUN_LOG"; exit $ec\' EXIT',
    'echo "[tmux-inner] exec $BUN /work/src/app.ts --ui console" >> "$RUN_LOG"',
    'exec "$BUN" /work/src/app.ts --ui console',
    "EOS",
    `chmod +x ${INNER}`,

    // Tmux config — keep pane when command exits; do not kill server/client on destroy.
    `cat > ${TMUX_CONF} <<'EOF'`,
    "set -g mouse on",
    "set -g remain-on-exit on",
    "set -g detach-on-destroy off",
    "set -g exit-empty off",
    // A tiny hint in the status so we know we're on the right socket/session
    'set -g status-left "org #[fg=yellow]#{session_name}#[default] #{pane_title}"',
    "EOF",

    // Version + socket path breadcrumbs
    `echo "[tmux/launcher] tmux version: $(/usr/bin/tmux -V 2>&1)" >> ${RUN_LOG}`,
    `echo "[tmux/launcher] socket label: ${TMUX_SOCKET_NAME}" >> ${RUN_LOG}`,
    `echo "[tmux/launcher] conf: ${TMUX_CONF}" >> ${RUN_LOG}`,
    `echo "[tmux/launcher] inner: ${INNER}" >> ${RUN_LOG}`,

    // NEW SESSION (detached) with -vv to ensure logs are written, then attach.
    // We deliberately do *not* '|| true' around new-session; if that fails we want the error.
    `/usr/bin/tmux -vv -f ${TMUX_CONF} -L ${TMUX_SOCKET_NAME} new-session -d -s org -n console ${INNER}`,
    `echo "[tmux/launcher] new-session rc=$? $(date -Is)" >> ${RUN_LOG}`,
    // Attach; we annotate rc explicitly so we can distinguish ESC/exit vs. error
    `/usr/bin/tmux -L ${TMUX_SOCKET_NAME} attach -t org`,
    `echo "[tmux/launcher] attach rc=$? $(date -Is)" >> ${RUN_LOG}`,
  ].join("\n");

  const { code } = await shInteractive(["bash", "-lc", script], { projectDir, agentSessionId });

  Logger.info("[org/tmux] launcher end", { code });
  return code ?? 0;
}

/**
 * Minimal tmux presence check where we're about to run it.
 * IMPORTANT: use interactive exec (capture is not implemented in Podman session).
 */
async function doctorTmux(projectDir: string, agentSessionId: string): Promise<number> {
  const { code } = await shInteractive(['bash', '-lc', 'command -v tmux >/dev/null 2>&1'], {
    projectDir,
    agentSessionId,
  });
  return code ?? 127;
}
