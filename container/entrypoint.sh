#!/usr/bin/env bash
# container/entrypoint.sh
#
# Single-container session entrypoint:
#   - Mirror /project (host repo, ro) -> /work (rw).
#   - Baseline /work (git init/commit) so patch review diffs against HEAD.
#   - Honor ORG_DEFAULT_CWD (e.g., /work/sub/area) for app/tools.
#   - Exec the app (set with APP_CMD; defaults to "bun run /app/dist/app.js").
#
# Required host mounts:
#   -v <host/repo>:/project:ro,Z
#   -v <host/repo>/.org:/hostrun:rw,Z      # optional: store runs/patches on host

set -euo pipefail

: "${PROJECT_MOUNT:=/project}"        # host repo mount (read-only)
: "${WORKDIR:=/work}"                 # workspace inside container (read-write)
: "${HOSTRUN_MOUNT:=/hostrun}"        # runs/patch artifacts if you want to persist to host
: "${ORG_DEFAULT_CWD:=/work}"         # default cwd for app/tools (e.g., /work/examples)
: "${APP_CMD:=bun run /app/dist/app.js}"  # how to start your app (adjust if needed)
: "${TRACE:=0}"

_log() { printf '[entry] %s\n' "$*" >&2; }

# Banner for quick diagnosis
_log "PROJECT_MOUNT=${PROJECT_MOUNT}"
_log "WORKDIR=${WORKDIR}"
_log "ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD}"
_log "APP_CMD=${APP_CMD}"

mkdir -p "${WORKDIR}" "${HOSTRUN_MOUNT}"

# 1) Mirror repo from /project -> /work (idempotent)
if command -v rsync >/dev/null 2>&1; then
  _log "rsync /project -> /work"
  rsync -a --delete \
    --exclude ".git/***" \
    --exclude ".org/***" \
    --filter="P .org/" \
    "${PROJECT_MOUNT}/." "${WORKDIR}/"
else
  _log "cp -a /project -> /work (rsync not present)"
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

# Optional: start the app from ORG_DEFAULT_CWD
if [ -n "${ORG_DEFAULT_CWD:-}" ] && [ -d "${ORG_DEFAULT_CWD}" ]; then
  cd "${ORG_DEFAULT_CWD}"
fi

# 4) Exec the app
_log "exec: ${APP_CMD}"
exec ${APP_CMD}
