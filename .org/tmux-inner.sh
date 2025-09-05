#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${ORG_LOG_DIR:?}"
APP_LOG="${INNER_LOG:?}"
ENTRY="${ORG_ENTRY:?}"
SHELL_BIN="${SHELL_BIN:-/bin/bash}"
SCRIPT_BIN="${SCRIPT_BIN:-}"

{
  echo "===== org tmux-inner start: $(date -Is) ====="
  echo "[inner] cwd=$(pwd) uid=$(id -u):$(id -g) PATH=$PATH"
  echo "[inner] entry: \$ENTRY"
} >>"$APP_LOG" 2>&1

# If util-linux `script` is available, use it to preserve a real PTY while logging.
if [[ -n "$SCRIPT_BIN" ]]; then
  exec "$SCRIPT_BIN" -qfe -c "$ENTRY" "$APP_LOG"
fi

# Fallback keeps logs but may reduce interactivity (no PTY).
exec "$SHELL_BIN" -lc "$ENTRY 2>&1 | tee -a \"$APP_LOG\"; exit \${PIPESTATUS[0]}"
