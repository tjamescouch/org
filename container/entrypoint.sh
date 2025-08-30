#!/usr/bin/env bash
# container/entrypoint.sh
#
# Single-container session entrypoint:
#   1) Mirror /project (ro) -> /work (rw) once at startup (fast rsync).
#   2) Baseline /work with a Git repo/commit so patch review works.
#   3) Honor ORG_DEFAULT_CWD (/work or /work/<subdir>) for tools/app.
#   4) Exec the app (default: bun run dist/app.js).
#
# Required mounts (host):
#   -v <host/repo>:/project:ro,Z
#   -v <host/repo>/.org:/hostrun:rw,Z   (optional; for runs/patches if you persist externally)
#
# Example host launch:
#   ROOT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
#   SUB="$(python3 - <<'PY' "$ROOT" "$PWD"
# import os, sys; r=os.path.realpath(sys.argv[1]); c=os.path.realpath(sys.argv[2])
# print(os.path.relpath(c, r) if c.startswith(r+os.sep) else "")
# PY
# )"
#   ORG_DEFAULT_CWD="/work${SUB:+/$SUB}"
#   podman run --rm -it \
#     -v "$ROOT:/project:ro,Z" \
#     -v "$ROOT/.org:/hostrun:rw,Z" \
#     -e ORG_DEFAULT_CWD="$ORG_DEFAULT_CWD" \
#     -w /work \
#     localhost/org-build:debian-12 \
#     /usr/local/bin/org-entrypoint

set -euo pipefail

: "${PROJECT_MOUNT:=/project}"     # host repo mount (read-only)
: "${WORKDIR:=/work}"              # workspace inside container (read-write)
: "${HOSTRUN_MOUNT:=/hostrun}"     # optional host run root (for artifacts/patches if you want)
: "${ORG_DEFAULT_CWD:=/work}"      # default cwd for tools/app (e.g., /work/examples)
: "${APP_CMD:=bun run dist/app.js}"# app command; override with APP_CMD if needed
: "${TRACE:=0}"

log() { printf '[entry] %s\n' "$*" >&2; }

log "PROJECT_MOUNT=${PROJECT_MOUNT}"
log "WORKDIR=${WORKDIR}"
log "ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD}"
log "APP_CMD=${APP_CMD}"

mkdir -p "${WORKDIR}" "${HOSTRUN_MOUNT}"

# 1) Mirror repo from /project -> /work (fast & idempotent)
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

# 2) Baseline /work (so patch review produces a clean diff against HEAD)
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

# Optional: start the app in ORG_DEFAULT_CWD (useful if you want app’s process.cwd to match)
if [ -n "${ORG_DEFAULT_CWD:-}" ] && [ -d "${ORG_DEFAULT_CWD}" ]; then
  cd "${ORG_DEFAULT_CWD}"
fi

# 4) Exec the app (keep logs compact; stderr/stdout are the container logs)
log "exec: ${APP_CMD}"
exec ${APP_CMD}
