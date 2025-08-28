#!/usr/bin/env bash
# Console UI launcher
set -Eeuo pipefail

log() { printf '[org/console] %s\n' "$*"; }

log "console launcher start"
log "pwd: $(pwd)"
log "APPDIR: ${APPDIR:-$(pwd)}"
log "bun: $(command -v bun 2>/dev/null || echo 'not found')"
TTY_STATE="$([ -t 0 ] && echo tty || echo ntty)"   # <-- no arithmetic substitution
ISATTY="$(python3 -c 'import os,sys; print(os.isatty(0))' 2>/dev/null || true)"
log "TERM: ${TERM:-unset}  TTY: ${TTY_STATE}  isatty=${ISATTY}"

# Keep the user's cwd. Run the same entry the tmux inner script runs.
if command -v /usr/local/bin/bun >/dev/null 2>&1; then
  exec /usr/local/bin/bun /work/src/app.ts "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun /work/src/app.ts "$@"
fi

log "bun not found"
exit 127
