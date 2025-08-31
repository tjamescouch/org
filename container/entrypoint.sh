#!/usr/bin/env bash
# container/entrypoint.sh
#
# Single-container session entrypoint:
#   - Mirror /project (ro) -> /work (rw)
#   - Baseline /work
#   - Honor ORG_DEFAULT_CWD (/work or /work/<subdir>)
#   - Exec the app ('org' by default), forwarding CLI args

set -euo pipefail

: "${PROJECT_MOUNT:=/project}"
: "${WORKDIR:=/work}"
: "${HOSTRUN_MOUNT:=/hostrun}"
: "${ORG_DEFAULT_CWD:=/work}"
: "${APP_CMD:=org}"

log() { printf '[entry] %s\n' "$*" >&2; }

log "PROJECT_MOUNT=${PROJECT_MOUNT}"
log "WORKDIR=${WORKDIR}"
log "ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD}"
log "APP_CMD=${APP_CMD}"

mkdir -p "${WORKDIR}" "${HOSTRUN_MOUNT}"

if command -v rsync >/dev/null 2>&1; then
  log "rsync /project -> /work"
  rsync -a --delete \
    --exclude ".git/***" \
    --exclude ".org/***" \
    --filter="P .org/" \
    "${PROJECT_MOUNT}/." "${WORKDIR}/"
else
  log "cp -a /project -> /work (rsync not present)"
  find "${WORKDIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "${PROJECT_MOUNT}/." "${WORKDIR}/"
fi

cd "${WORKDIR}"
if ! [ -d .git ]; then
  git init -q
  git config user.email "org@example.com"
  git config user.name  "org"
  git add -A || true
  git commit -qm "baseline" || true
else
  git rev-parse --verify HEAD >/dev/null 2>&1 || git commit -qm "baseline (existing .git)"
fi
mkdir -p .org .org/steps

export ORG_PROJECT_DIR="${WORKDIR}"
export ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}"

# Optional: start the app directly in the default cwd
if [ -n "${ORG_DEFAULT_CWD:-}" ] && [ -d "${ORG_DEFAULT_CWD}" ]; then
  cd "${ORG_DEFAULT_CWD}"
fi

log "exec: ${APP_CMD} $*"
exec ${APP_CMD} "$@"
