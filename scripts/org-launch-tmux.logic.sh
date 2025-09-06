#!/usr/bin/env bash
# org-launch-tmux.logic.sh — container-first tmux launcher
set -Eeuo pipefail

workdir-sync-from-project.sh

ORG_DIR="${ORG_RUNTIME_DIR:-/work/.org}"
BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/work/src/app.ts}"
TMUX_CONF="${ORG_TMUX_CONF:-/scripts/tmux.conf}"
SESSION_NAME="${ORG_TMUX_SESSION:-org}"

export SANDBOX_BACKEND="none"

# Start tmux and run app pane from /work so `ls` shows project
tmux -f "${TMUX_CONF}" new-session -d -s "${SESSION_NAME}" \
  "cd /work && ${BUN_BIN} ${APP_ENTRY} --ui tmux --review never $*"

tmux attach -t "${SESSION_NAME}"

# After user exits tmux, create the patch
/scripts/patch-create.sh --out "${ORG_DIR}/last-session.patch" || true

echo "Patch (if any): ${ORG_DIR}/last-session.patch"
