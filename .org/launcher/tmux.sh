#!/usr/bin/env bash
set -Eeuo pipefail

# tmux launcher that respects --ui, robustly finds tmux in the *current OS*,
# and falls back to the console launcher when tmux is unavailable.
# Notes:
# - UI runs in the current shell environment (VM/host), not inside the sandbox container.
# - Set ORG_TMUX_BIN=/abs/path/to/tmux to hard-override detection.
# - Set ORG_DEBUG_LAUNCHER=1 for diagnostics.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SESSION_NAME="${ORG_TMUX_SESSION:-org}"
PANE_TITLE="${ORG_TMUX_PANE_TITLE:-org}"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"

debug() { [[ "${ORG_DEBUG_LAUNCHER:-0}" == "1" ]] && echo "[launcher] $*" >&2 || true; }

# ---------- collect forwarded args (env + argv) ----------
FWD="${ORG_FWD_ARGS-}"
declare -a ORG_ARGS=()
if [[ $# -gt 0 ]]; then ORG_ARGS+=("$@"); fi
if [[ -n "$FWD" ]]; then
  # best-effort split; upstream should quote values containing spaces
  read -r -a _arr <<<"$FWD"
  ORG_ARGS+=("${_arr[@]}")
fi
debug "argv: ${ORG_ARGS[*]}"

# ---------- determine requested UI ----------
UI="${ORG_UI-}"
if [[ -z "$UI" ]]; then
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
debug "UI=${UI}"

# ---------- console delegate (always via bash; no +x required) ----------
console_delegate() {
  debug "delegating to console.sh"
  exec bash "${SCRIPT_DIR}/console.sh" "${ORG_ARGS[@]}"
}

if [[ "${UI}" != "tmux" ]]; then
  console_delegate
fi

# ---------- robust tmux discovery ----------
find_tmux() {
  local cand
  # explicit override
  if [[ -n "${ORG_TMUX_BIN-}" && -x "${ORG_TMUX_BIN}" ]]; then
    echo "${ORG_TMUX_BIN}"; return 0
  fi
  # PATH lookup (may fail in non-login shells)
  cand="$(command -v tmux 2>/dev/null || true)"
  if [[ -n "$cand" && -x "$cand" ]]; then
    echo "$cand"; return 0
  fi
  # common absolute locations
  for cand in /usr/bin/tmux /bin/tmux /usr/local/bin/tmux /opt/homebrew/bin/tmux; do
    [[ -x "$cand" ]] && { echo "$cand"; return 0; }
  done
  return 1
}

TMUX_BIN="$(find_tmux || true)"
debug "PATH=${PATH}"
debug "TMUX_BIN=${TMUX_BIN:-<none>}"

if [[ -z "${TMUX_BIN}" ]]; then
  echo "tmux not found. Falling back to console UI." >&2
  console_delegate
fi

# ---------- choose runtime for the app ----------
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
printf -v RUN_CMD '%q ' "${RUN[@]}" "${ORG_ARGS[@]}"
START_CMD="cd ${ROOT_DIR} && LOG_FILE=${LOG_DIR}/run-\$(date -u +%Y-%m-%dT%H-%M-%SZ).log ${RUN_CMD}"
debug "START_CMD=${START_CMD}"

# ---------- start/attach session ----------
if ! "${TMUX_BIN}" has-session -t "${SESSION_NAME}" 2>/dev/null; then
  debug "creating new tmux session: ${SESSION_NAME}"
  "${TMUX_BIN}" new-session -d -s "${SESSION_NAME}" -n "${PANE_TITLE}" "${START_CMD}"
fi

"${TMUX_BIN}" select-window -t "${SESSION_NAME}:0"
exec "${TMUX_BIN}" attach-session -t "${SESSION_NAME}"
