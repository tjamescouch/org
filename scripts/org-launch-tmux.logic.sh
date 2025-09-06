#!/usr/bin/env bash
set -Eeuo pipefail

if command -v workdir-sync-from-project.sh >/dev/null 2>&1; then
  workdir-sync-from-project.sh
fi

export SANDBOX_BACKEND=none

ORG_DIR="${ORG_RUNTIME_DIR:-/work/.org}"
BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/work/src/app.ts}"
TMUX_CONF="${ORG_TMUX_CONF:-/scripts/tmux.conf}"
SESSION_NAME="${ORG_TMUX_SESSION:-org}"

tmux -f "${TMUX_CONF}" new-session -d -s "${SESSION_NAME}" \
  "cd /work && ${BUN_BIN} ${APP_ENTRY} --ui tmux --review never $*"

tmux attach -t "${SESSION_NAME}"

if [[ -x /scripts/patch-create.sh ]]; then
  /scripts/patch-create.sh --out "${ORG_DIR}/last-session.patch" || true
fi
