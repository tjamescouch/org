/* tmux UI launcher — simple, robust, no backslash soup
 *
 * - Runs tmux inside the sandbox (no extra container hop).
 * - Writes a tiny /work/.org/tmux-inner.sh that runs the app and keeps
 *   the pane open on exit (remain-on-exit + prompt), teeing output to a log.
 * - Puts tmux client/server logs under /work/.org/logs/tmux-logs/tmux-0.
 */

import { Logger } from "../../logger";
import { shInteractive, shCapture } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

/** Launch the tmux UI inside the sandbox. */
export async function launchTmuxUI(argv: string[], scope: Scope = "container"): Promise<number> {
  // Always prefer /work if the wrapper script exported it; otherwise fall back.
  const projectDir = process.env.ORG_PROJECT_DIR || "/work";
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID || "default";

  const entry = "/work/src/app.ts";

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId,
    entry,
  });

  // doctor: make sure tmux is available where we're about to run it
  const rc = await doctorTmux(scope, projectDir, agentSessionId);
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc });
  if (rc !== 0) {
    throw new Error(
      "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.",
    );
  }

  // Build the script without template literals so ${…} stays literal bash.
  // We also keep it entirely self-contained to avoid quoting surprises.
  const tmuxScript = [
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    'LOG_DIR="/work/.org/logs"',
    'TMUX_DIR="$LOG_DIR/tmux-logs"',
    'CONF="/work/.org/tmux.conf"',
    'INNER="/work/.org/tmux-inner.sh"',
    'SOCK_LABEL="tmux-0"',
    "",
    'mkdir -p "$TMUX_DIR" "$LOG_DIR"',
    "",
    'echo "[tmux/launcher] begin $(date -Is)"',
    'echo "[tmux/launcher] tmux version: $(/usr/bin/tmux -V 2>/dev/null || tmux -V || echo unknown)"',
    'echo "[tmux/launcher] socket label: $SOCK_LABEL"',
    'echo "[tmux/launcher] conf: $CONF"',
    'echo "[tmux/launcher] inner: $INNER"',
    "",
    "# --- Write tmux.conf with deterministic settings ---",
    'cat > "$CONF" <<\'CONF\'',
    'set -g default-terminal "xterm-256color"',
    "set -g mouse on",
    "set -g escape-time 0",
    "set -g remain-on-exit on           # keep pane visible after app exits",
    "set -g detach-on-destroy off       # don’t drop the server if a client detaches",
    "# Keep the default prefix (C-b). Feel free to add your custom binds here.",
    "CONF",
    "",
    "# --- Write the inner runner that starts the app and keeps the pane open ---",
    'cat > "$INNER" <<\'INN\'',
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "",
    '# Find bun deterministically (prefer /usr/local/bin/bun; fall back to PATH)',
    'BUN="/usr/local/bin/bun"',
    'if ! command -v \"$BUN\" >/dev/null 2>&1; then',
    '  BUN=\"$(command -v bun || true)\"',
    "fi",
    "",
    "cd /work",
    'logdir="/work/.org/logs"',
    'mkdir -p \"$logdir\"',
    'ts=\"$(date -Is | tr -d \':-\')\"',
    'applog=\"$logdir/org-app-$ts.log\"',
    'echo \"[tmux-inner] exec $BUN /work/src/app.ts --ui console\" | tee -a \"$applog\"',
    "",
    '# Run the app; tee output to the log and preserve the app exit code.',
    '$BUN /work/src/app.ts --ui console 2>&1 | tee -a \"$applog\"',
    'ec=${PIPESTATUS[0]}',
    'echo \"[tmux-inner] app exit=$ec, log=$applog\" | tee -a \"$applog\"',
    "",
    "# Keep pane visible so the user can read the tail or copy the log path.",
    'echo \"[tmux-inner] press any key to close this pane\"',
    'stty -echo -icanon time 0 min 0 2>/dev/null || true',
    'dd bs=1 count=1 of=/dev/null 2>/dev/null || true',
    "exit \"$ec\"",
    "INN",
    "chmod +x \"$INNER\"",
    "",
    "# --- Run tmux (labelled socket; explicit conf; working dir /work) ---",
    'export TMUX_TMPDIR=\"$TMUX_DIR\"',
    "",
    '# -vv on the *first* command ensures client/server logs appear in $PWD',
    'echo \"[tmux/launcher] new-session begin $(date -Is)\"',
    '/usr/bin/tmux -vv -L \"$SOCK_LABEL\" -f \"$CONF\" new-session -d -s org -c /work \"$INNER\"',
    'rc=$?',
    'echo \"[tmux/launcher] new-session rc=$rc $(date -Is)\"',
    "",
    '# Attach (no -vv needed here; logs are already open).',
    '/usr/bin/tmux -L \"$SOCK_LABEL\" attach -t org',
    "",
  ].join("\n");

  // Execute interactively inside the sandbox (preserves the user’s TTY).
  const { code } = await shInteractive(["bash", "-lc", tmuxScript], {
    projectDir,
    agentSessionId,
  });

  Logger.info("[org/tmux] launcher end", { code: code ?? 0 });
  return code ?? 0;
}

/**
 * Minimal tmux presence check where we're about to run it.
 * IMPORTANT: use interactive exec (capture is not implemented in Podman session).
 */
async function doctorTmux(
  _scope: Scope,
  projectDir: string,
  agentSessionId: string
): Promise<number> {
  // We only care about an exit status; suppress output.
  const { code } = await shInteractive(
    ['bash', '-lc', 'command -v tmux >/dev/null 2>&1 || /usr/bin/tmux -V >/dev/null 2>&1'],
    { projectDir, agentSessionId },
  );
  return code ?? 127;
}
