#!/usr/bin/env bash
set -Eeuo pipefail

# Robust tmux launcher that respects --ui and falls back to console when tmux
# is not present. It never depends on console.sh being executable; we run it
# via bash to avoid "Permission denied" on non-+x files.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SESSION_NAME="${ORG_TMUX_SESSION:-org}"
PANE_TITLE="${ORG_TMUX_PANE_TITLE:-org}"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"

# ----- collect forwarded args (from env and/or argv) -------------------------
FWD="${ORG_FWD_ARGS-}"
declare -a ORG_ARGS=()
# include arguments passed directly to this script (if any)
if [[ $# -gt 0 ]]; then ORG_ARGS+=("$@"); fi
# include arguments forwarded via env string
if [[ -n "${FWD}" ]]; then
  # shellwords-ish split (caller should quote; this is best-effort)
  read -r -a _arr <<<"$FWD"
  ORG_ARGS+=("${_arr[@]}")
fi

# ----- determine requested UI ------------------------------------------------
UI="${ORG_UI-}"   # explicit env overrides CLI
if [[ -z "${UI}" ]]; then
  # parse --ui console|tmux or --ui=console|tmux
  for ((i=0; i<${#ORG_ARGS[@]}; i++)); do
    a="${ORG_ARGS[$i]}"
    if [[ "$a" == "--ui" ]]; then
      UI="${ORG_ARGS[$((i+1))]:-}"
      break
    elif [[ "$a" == --ui=* ]]; then
      UI="${a#--ui=}"
      break
    fi
  done
fi
UI="${UI:-tmux}"

# ---- delegate to console launcher (via bash) when requested or required ----
console_delegate() {
  # Always invoke through bash to avoid permission issues on console.sh
  exec bash "${SCRIPT_DIR}/console.sh" "${ORG_ARGS[@]}"
}

if [[ "${UI}" != "tmux" ]]; then
  console_delegate
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Falling back to console UI." >&2
  console_delegate
fi

# ----- choose runtime for the app -------------------------------------------
ENTRY="${ROOT_DIR}/src/app.ts"
declare -a RUN
if command -v bun >/dev/null 2>&1; then
  RUN=(bun "${ENTRY}")
elif [[ -f "${ROOT_DIR}/dist/app.js" ]] && command -v node >/dev/null 2>&1; then
  RUN=(node "${ROOT_DIR}/dist/app.js")
elif command -v tsx >/dev/null 2>&1; then
  RUN=(tsx "${ENTRY}")
else
  RUN=(node --loader ts-node/esm "${ENTRY}")
fi

# Build a safely-quoted command for tmux to run
printf -v RUN_CMD '%q ' "${RUN[@]}" "${ORG_ARGS[@]}"
START_CMD="cd ${ROOT_DIR} && LOG_FILE=${LOG_DIR}/run-\$(date -u +%Y-%m-%dT%H-%M-%SZ).log ${RUN_CMD}"

# ----- start tmux session (create if missing) -------------------------------
if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  tmux new-session -d -s "${SESSION_NAME}" -n "${PANE_TITLE}" "${START_CMD}"
fi

tmux select-window -t "${SESSION_NAME}:0"
exec tmux attach-session -t "${SESSION_NAME}"
