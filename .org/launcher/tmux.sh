#!/usr/bin/env bash
set -Eeuo pipefail

# Robust tmux launcher for org. Works even if invoked by /bin/sh caller.
# Fixes: "bad substitution" by avoiding ${#arr[@]:-0} and forcing bash.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SESSION_NAME="${ORG_TMUX_SESSION:-org}"
PANE_TITLE="${ORG_TMUX_PANE_TITLE:-org}"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"

# Forward all CLI args the user passed after '--' into org.
# Accept both array-style and string-style envs from upstream sh callers.
FWD="${ORG_FWD_ARGS-}"
if [[ -n "$FWD" ]]; then
  # shellwords-safe: expect upstream to quote; otherwise, just pass as-is
  read -r -a ORG_ARGS <<<"$FWD"
else
  ORG_ARGS=()
fi

# Entry: prefer bun if available, else node on built dist, else ts-node/tsx.
ENTRY="${ROOT_DIR}/src/app.ts"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Install tmux or run with '--ui console'." >&2
  exit 1
fi

# Create session if it doesn't exist
if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  tmux new-session -d -s "${SESSION_NAME}" -n "${PANE_TITLE}" \
    "cd ${ROOT_DIR} && LOG_FILE=${LOG_DIR}/run-\$(date -u +%Y-%m-%dT%H-%M-%SZ).log \
      ${BUN:-bun} ${ENTRY} ${ORG_ARGS[*]}"
fi

tmux select-window -t "${SESSION_NAME}:0"
tmux attach-session -t "${SESSION_NAME}"
