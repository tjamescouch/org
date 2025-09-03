// Simple, shell-free tmux.conf generator.

export function buildTmuxConf(): string {
  // tmux syntax ONLY — no shell fragments, no EOF markers, no comments that start with '#!'
  return [
    'set -s exit-empty off',
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"',
    'set -g focus-events on',
    'set -s quiet on',

    // A minimal status line (optional; keeps errors visible if any)
    'set -g status-left "[org] #{session_name}:#{window_index}.#{pane_index} "',
  ].join('\n') + '\n';
}

/**
 * Build the inner script that runs inside the tmux pane.
 * Keep it bash-only; no dependence on tmux here.
 */
export function buildInnerScript(entryCmd: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'umask 0002',
    '',
    'export TERM=xterm-256color',
    'export LANG=en_US.UTF-8',
    '',
    'LOG_DIR="/work/.org/logs"',
    'mkdir -p "$LOG_DIR" "$LOG_DIR/tmux-logs"',
    'APP_LOG="$LOG_DIR/org-app-$(date -Is).log"',
    '',
    '# Pick bun if needed for the entryCmd',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  if [ -x /usr/local/bin/bun ]; then PATH="/usr/local/bin:$PATH"; fi',
    '  if [ -x /home/ollama/.bun/bin/bun ]; then PATH="/home/ollama/.bun/bin:$PATH"; fi',
    '  if [ -x /root/.bun/bin/bun ]; then PATH="/root/.bun/bin:$PATH"; fi',
    'fi',
    '',
    'cd /work',
    'echo "[tmux-inner] start $(date -Is)"   | tee -a "$APP_LOG" >/dev/null',
    'stty -a | sed "s/.*/[tmux-inner] stty: &/g" | tee -a "$APP_LOG" >/dev/null || true',
    'env | sort | sed "s/.*/[tmux-inner] env: &/g" | tee -a "$APP_LOG" >/dev/null || true',
    '',
    '# Prefer util-linux `script` to keep a PTY and preserve exit code',
    'if command -v script >/dev/null 2>&1; then',
    `  exec script -qfe -c '${entryCmd}' "$APP_LOG"`,
    'else',
    `  exec bash -lc '${entryCmd} 2>&1 | tee -a "$APP_LOG"; test ${PIPESTATUS[0]} -eq 0'`,
    'fi',
    '',
  ].join('\n');
}
