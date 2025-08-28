#!/usr/bin/env bash
# vim: set ts=2 sw=2 et:
set -Eeuo pipefail

# Console UI path with targeted logging. Safe to keep enabled permanently.

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${LOG_DIR}" || true
LAUNCH_LOG="${LOG_DIR}/console-launcher-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# Tee stdout+stderr to terminal and file so we always see something.
exec > >(awk '{ print; fflush() }' | tee -a "${LAUNCH_LOG}") 2>&1

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ printf '[%s] [org/console] %s\n' "$(ts)" "$*"; }

trap 'log "ERROR line ${BASH_LINENO[0]}: ${BASH_COMMAND:-?} (rc=$?)"' ERR
trap 'log "console-launcher exit code: $?"' EXIT

log "console launcher start"
log "pwd: $(pwd)"
log "APPDIR: ${APPDIR}"
log "TERM: ${TERM:-unset}  TTY: ${([ -t 0 ] && echo tty) || echo ntty}  isatty=$(python3 -c "import sys,os; print(os.isatty(0))" 2>/dev/null || true)"

ENTRY="${ORG_APPDIR:-${APPDIR}}/src/app.ts"
if [[ ! -f "${ENTRY}" ]]; then
  log "ENTRY missing: ${ENTRY}  (ORG_APPDIR='${ORG_APPDIR-}')"
  exit 1
fi

# Make sure bun is visible, and print its version for traceability.
if ! command -v bun >/dev/null 2>&1; then
  log "bun not found on PATH"
  exit 1
fi
log "bun: $(command -v bun)  version: $(bun --version 2>/dev/null || echo '?')"

# Force console UI on the app so we’re aligned with this launcher.
export ORG_FORCE_UI="${ORG_FORCE_UI:-console}"

log "exec: bun '${ENTRY}' $*"
exec bun "${ENTRY}" "$@"
