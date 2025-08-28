#!/usr/bin/env bash
# vim: set ts=2 sw=2 et:
set -Eeuo pipefail

# Top-level runner. Adds early, high-signal logging so we can see why the app
# would exit. Delegates to .org/launcher/{console,tmux}.sh but never fails
# silently: every branch is logged and visible in both the terminal and a file.

# ── repo layout ───────────────────────────────────────────────────────────────
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="${APPDIR}/.org/launcher"
LOG_DIR="${APPDIR}/.org/logs"
mkdir -p "${LOG_DIR}" || true
RUN_LOG="${LOG_DIR}/runner-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# Tee stdout+stderr to terminal and to the log
exec > >(awk '{ print; fflush() }' | tee -a "${RUN_LOG}") 2>&1

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] [org/run] %s\n' "$(ts)" "$*"; }
stage() { log "── $*"; }

trap 'log "ERROR line ${BASH_LINENO[0]}: ${BASH_COMMAND:-?} (rc=$?)"' ERR
trap 'log "runner exit code: $?"' EXIT

stage "runner start"
log "log file -> ${RUN_LOG}"
log "pwd: $(pwd)"
log "APPDIR: ${APPDIR}"
log "argv: $*"

# ── UI selection (env or --ui flag; default tmux) ────────────────────────────
UI="${ORG_UI-}"
if [[ -z "${UI}" ]]; then
  # parse --ui console|tmux or --ui=console|tmux
  for ((i=1; i<=$#; i++)); do
    a="${!i}"
    if [[ "$a" == "--ui" ]]; then
      j=$((i+1)); UI="${!j:-}"; break
    elif [[ "$a" == --ui=* ]]; then
      UI="${a#--ui=}"; break
    fi
  done
fi
UI="${UI:-tmux}"
log "UI selected: ${UI}"

# ── resolve launchers ────────────────────────────────────────────────────────
TMUX_SH="${LAUNCH_DIR}/tmux.sh"
CONSOLE_SH="${LAUNCH_DIR}/console.sh"

if [[ ! -d "${LAUNCH_DIR}" ]]; then
  log "launcher dir missing: ${LAUNCH_DIR}"
fi
log "console.sh: ${CONSOLE_SH} $( [[ -f "${CONSOLE_SH}" ]] && echo '[found]' || echo '[MISSING]' )"
log "tmux.sh:    ${TMUX_SH} $( [[ -f "${TMUX_SH}"    ]] && echo '[found]' || echo '[MISSING]' )"

# ── delegate with loud, deterministic fallback ───────────────────────────────
if [[ "${UI}" == "tmux" ]]; then
  if [[ -f "${TMUX_SH}" ]]; then
    stage "exec tmux launcher"
    # Always invoke via bash so executable bit never matters.
    exec bash "${TMUX_SH}" "$@"
  else
    log "tmux launcher missing; falling back to console"
    if [[ -f "${CONSOLE_SH}" ]]; then
      stage "exec console launcher (fallback)"
      exec bash "${CONSOLE_SH}" "$@"
    else
      log "console launcher also missing; aborting"
      exit 1
    fi
  fi
else
  if [[ -f "${CONSOLE_SH}" ]]; then
    stage "exec console launcher"
    exec bash "${CONSOLE_SH}" "$@"
  else
    log "console launcher missing; trying tmux as fallback"
    if [[ -f "${TMUX_SH}" ]]; then
      stage "exec tmux launcher (fallback)"
      exec bash "${TMUX_SH}" "$@"
    else
      log "no launcher available; aborting"
      exit 1
    fi
  fi
fi
