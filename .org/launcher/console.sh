#!/usr/bin/env bash
# vim: set ts=2 sw=2 et:
set -Eeuo pipefail

# Console UI launcher with targeted logging (no brittle substitutions)

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${LOG_DIR}" || true
LAUNCH_LOG="${LOG_DIR}/console-launcher-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# Stream logs to terminal and file (line-buffered)
exec > >(awk '{ print; fflush() }' | tee -a "${LAUNCH_LOG}") 2>&1

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ printf '[%s] [org/console] %s\n' "$(ts)" "$*"; }

trap 'log "ERROR line ${BASH_LINENO[0]}: ${BASH_COMMAND:-?} (rc=$?)"' ERR
trap 'log "console-launcher exit code: $?"' EXIT

log "console launcher start"
log "pwd: $(pwd)"
log "APPDIR: ${APPDIR}"

# TTY info without fancy substitution (portable)
if [ -t 0 ]; then
  tty_state="tty"
else
  tty_state="ntty"
fi
log "TERM: ${TERM:-unset}  TTY: ${tty_state}"

ENTRY="${ORG_APPDIR:-${APPDIR}}/src/app.ts"
if [[ ! -f "${ENTRY}" ]]; then
  log "ENTRY missing: ${ENTRY}  (ORG_APPDIR='${ORG_APPDIR-}')"
  exit 1
fi

# bun is required in console mode; if unavailable, be explicit
if ! command -v bun >/dev/null 2>&1; then
  log "bun not found on PATH. Install bun or use '--ui tmux' (containerized)."
  exit 1
fi
log "bun: $(command -v bun)  version: $(bun --version 2>/dev/null || echo '?')"

# Force console UI for the app
export ORG_FORCE_UI="${ORG_FORCE_UI:-console}"

log "exec: bun '${ENTRY}' $*"
exec bun "${ENTRY}" "$@"
