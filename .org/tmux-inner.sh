#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${ORG_LOG_DIR:?}"
APP_LOG="${INNER_LOG:?}"
ENTRY_STR="${ORG_CMD_STR:?}"
SHELL_BIN="${SHELL_BIN:-/bin/bash}"
SCRIPT_BIN="${SCRIPT_BIN:-}"

{
  echo "===== org tmux-inner start: $(date -Is) ====="
  echo "[inner] cwd=$(pwd) uid=$(id -u):$(id -g) PATH=$PATH"
  echo "[inner] entry: ${ENTRY_STR}"
} >>"$APP_LOG" 2>&1

# If util-linux `script` is available, use it to preserve a real PTY while logging.
if [[ -n "$SCRIPT_BIN" ]]; then
  exec "$SCRIPT_BIN" -qfe -c "$ENTRY_STR" "$APP_LOG"
fi

# Fallback keeps logs (tee) but lacks PTY semantics.
exec "$SHELL_BIN" -lc "$ENTRY_STR 2>&1 | tee -a \"$APP_LOG\"; exit \${PIPESTATUS[0]}"
