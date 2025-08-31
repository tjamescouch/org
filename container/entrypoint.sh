#!/usr/bin/env bash
# container/entrypoint.sh
#
# Single-container session entrypoint:
#   - Mirror /project (host repo, ro) -> /work (rw).
#   - Baseline /work (git init/commit) so patch review diffs against HEAD.
#   - Honor ORG_DEFAULT_CWD (e.g., /work/sub/area) for app/tools.
#   - Exec the app ('org' by default), forwarding CLI args.

set -euo pipefail

: "${PROJECT_MOUNT:=/project}"         # host repo mount (read-only)
: "${WORKDIR:=/work}"                  # workspace inside container (read-write)
: "${HOSTRUN_MOUNT:=/hostrun}"         # runs/patch artifacts if you persist to host (optional)
: "${ORG_DEFAULT_CWD:=/work}"          # default cwd for app/tools (e.g., /work/examples)
: "${APP_CMD:=org}"                    # how to start your app; default 'org'

log() { printf '[entry] %s\n' "$*" >&2; }

log "PROJECT_MOUNT=${PROJECT_MOUNT}"
log "WORKDIR=${WORKDIR}"
log "ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD}"
log "APP_CMD=${APP_CMD}"

mkdir -p "${WORKDIR}" "${HOSTRUN_MOUNT}"

# 1) Mirror repo from /project -> /work (idempotent)
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

# 2) Baseline /work (so patch review diffs against baseline)
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

# 3) Export env visible to app/tools
export ORG_PROJECT_DIR="${WORKDIR}"
export ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}"
# *** IMPORTANT: tell the app what the host "cwd" should be (so it resolves /work correctly) ***
export ORG_HOST_PWD="${ORG_DEFAULT_CWD}"

# Optional: start the app directly in the default cwd
if [ -n "${ORG_DEFAULT_CWD:-}" ] && [ -d "${ORG_DEFAULT_CWD}" ]; then
  cd "${ORG_DEFAULT_CWD}"
fi

# 4) Exec the app (forward CLI args)
log "exec: ${APP_CMD} $*"
exec ${APP_CMD} "$@"
