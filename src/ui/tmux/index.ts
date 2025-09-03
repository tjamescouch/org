// src/ui/tmux/index.ts
/* tmux UI launcher — single-file, robust, with debug and minimal deps */

import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

/**
 * Launch the tmux UI inside the sandbox.
 *  - Writes a tiny /work/.org/tmux.conf (remain-on-exit, etc)
 *  - Writes /work/.org/tmux-inner.sh that runs the console UI and logs
 *  - Creates a private tmux server (-L tmux-0) then attaches
 */
export async function launchTmuxUI(argv: string[], scope: Scope = "container"): Promise<number> {
  const projectDir = process.env.ORG_PROJECT_DIR ?? process.cwd();
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID ?? "default";

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

  // We generate both tmux.conf and the inner script. Then:
  //   tmux -L tmux-0 -f /work/.org/tmux.conf new-session -d -s org /work/.org/tmux-inner.sh
  //   tmux -L tmux-0 attach -t org
  //
  // - remain-on-exit keeps the pane visible even if the app exits (we can inspect errors)
  // - dedicated socket label avoids collisions (tmux-0)
  // - inner script logs app output so "child exited" is actionable
  const tmuxScript = [
    "set -Eeuo pipefail",
    "umask 0002",
    'LOGDIR="/work/.org/logs"',
    'CONF="/work/.org/tmux.conf"',
    'INNER="/work/.org/tmux-inner.sh"',
    'SOCK="tmux-0"',
    'mkdir -p \"$LOGDIR\" \"$LOGDIR/tmux-logs\"',
    "",
    "# ---- ephemeral tmux.conf (keep pane on failure; keep server alive) ----",
    "cat > \"$CONF\" <<'CONF'",
    'set -g default-terminal "tmux-256color"',
    'set -ag terminal-overrides ",xterm*:Tc"',
    "set -s escape-time 25",
    "set -g focus-events on",
    "set -g mouse on",
    "set -g remain-on-exit on",
    "set -g exit-empty off",
    "set -g detach-on-destroy off",
    "# give the window a stable name so attach targets are deterministic",
    "rename-window org",
    "CONF",
    "",
    "# ---- ephemeral inner runner (logs + pane TTY) ----",
    "cat > \"$INNER\" <<'EOS'",
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    "# Ensure we are bound to the pane TTY (no surprises with stdio)",
    "exec </dev/tty >/dev/tty 2>&1",
    "",
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "",
    '# Pick bun',
    'BUN="/usr/local/bin/bun"',
    'if ! command -v "$BUN" >/dev/null 2>&1; then',
    "  if command -v bun >/dev/null 2>&1; then",
    '    BUN="$(command -v bun)"',
    "  elif [ -x /home/ollama/.bun/bin/bun ]; then",
    '    BUN="/home/ollama/.bun/bin/bun"',
    "  elif [ -x /root/.bun/bin/bun ]; then",
    '    BUN="/root/.bun/bin/bun"',
    "  fi",
    "fi",
    "",
    'APP_LOG="/work/.org/logs/org-app-$(date -Is).log"',
    'echo "[tmux-inner] begin $(date -Is)" | tee -a "$APP_LOG"',
    "stty -a | sed 's/.*/[tmux-inner] stty: &/g' | tee -a \"$APP_LOG\" || true",
    "env | sort | sed 's/.*/[tmux-inner] env: &/g' | tee -a \"$APP_LOG\" || true",
    "",
    'cd /work',
    "",
    "# Run the console UI and tee its output so we can inspect failures without the pane disappearing",
    '"$BUN" /work/src/app.ts --ui console 2>&1 | tee -a "$APP_LOG"',
    "rc=${PIPESTATUS[0]}",
    'echo "[tmux-inner] end $(date -Is) rc=${rc}" | tee -a "$APP_LOG"',
    "exit ${rc}",
    "EOS",
    "chmod +x \"$INNER\"",
    "",
    "# ---- create session and attach (dedicated socket; verbose logs kept by -vv) ----",
    'TMUX_TMPDIR="$LOGDIR/tmux-logs" export TMUX_TMPDIR',
    '/usr/bin/tmux -vv -L \"$SOCK\" -f \"$CONF\" new-session -d -s org \"$INNER\"',
    '/usr/bin/tmux      -L \"$SOCK\" attach -t org',
  ].join("\n");

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
  const { code } = await shInteractive(
    ["bash", "-lc", "command -v tmux >/dev/null 2>&1"],
    { projectDir, agentSessionId },
  );
  return code ?? 127;
}
