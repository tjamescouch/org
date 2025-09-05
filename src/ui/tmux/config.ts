// src/ui/tmux/config.ts
// Helpers to build tmux runtime files without shell quoting hazards.

/** Build a conservative tmux.conf suitable for starting the server. */
export function buildTmuxConf(): string {
  // tmux syntax ONLY — no shell fragments.
  return (
    `
# keep server/pane attachable even if the child exits
set -s exit-empty off
setw -g remain-on-exit on

# usability & color
set -g mouse on
set -g history-limit 100000
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"
set -g focus-events on
set -s escape-time 0

# (optional) a tiny status to help debugging
set -g status on
set -g status-interval 2
set -g status-left "[org] #{session_name}.#{window_index}.#{pane_index} " 
`);
}

/** Return the /work/.org/tmux-inner.sh body. */
export function buildInnerScript(entryCmd: string): string {
  // Single-quote the command for shell; escape single quotes defensively.
  const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  return [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'umask 002',
    '',
    'ORG_DIR="/work/.org"',
    'LOG_DIR="${ORG_DIR}/logs"',
    'APP_LOG="${LOG_DIR}/tmux-inner.log"',
    'mkdir -p "${LOG_DIR}" "${LOG_DIR}/tmux-logs"',
    '',
    'echo "[tmux-inner] start $(date -Is)"   | tee -a "${APP_LOG}" >/dev/null',
    'echo "[tmux-inner] cwd: $(pwd) user=$(id -u):$(id -g)" | tee -a "${APP_LOG}" >/dev/null',
    'stty -a   | sed "s/.*/[tmux-inner] stty: &/g" | tee -a "${APP_LOG}" >/dev/null || true',
    'env | sort | sed "s/.*/[tmux-inner] env: &/g"  | tee -a "${APP_LOG}" >/dev/null || true',
    '',
    '# Prefer util-linux `script` to keep a PTY and preserve exit code',
    'if command -v script >/dev/null 2>&1; then',
    `  exec script -qfe -c ${q(entryCmd)} "${'$'}{APP_LOG}"`,
    'else',
    // Keep the child exit code even though we tee logs.
    `  exec bash -lc ${q(entryCmd + ' 2>&1 | tee -a "$APP_LOG"; exit ${PIPESTATUS[0]}')}`,
    'fi',
    '',
  ].join('\n') + '\n';
}
