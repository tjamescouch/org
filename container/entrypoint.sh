#!/usr/bin/env bash
# container/entrypoint.sh
# Single-container session entrypoint:
#  - Mirror /project (host repo) -> /work (sandbox rw copy)
#  - Baseline /work for patch review
#  - Honor ORG_DEFAULT_CWD (e.g., /work/sub/dir)
#  - Exec the app

set -euo pipefail

: "${PROJECT_MOUNT:=/project}"   # host repo mount (ro)
: "${WORKDIR:=/work}"            # working copy inside container (rw)
: "${HOSTRUN_MOUNT:=/hostrun}"   # host run root (rw) if you need to drop artifacts/patches
: "${ORG_DEFAULT_CWD:=/work}"    # default cwd for tools (e.g., /work/examples)

echo "[entry] PROJECT_MOUNT=${PROJECT_MOUNT}  WORKDIR=${WORKDIR}  ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD}"

mkdir -p "${WORKDIR}" "${HOSTRUN_MOUNT}"

# 1) Mirror repo from /project -> /work (fast & idempotent)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude ".git/***" \
    --exclude ".org/***" \
    --filter="P .org/" \
    "${PROJECT_MOUNT}/." "${WORKDIR}/"
else
  # portable fallback
  find "${WORKDIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "${PROJECT_MOUNT}/." "${WORKDIR}/"
fi

# 2) Baseline /work (so patch review works deterministically)
cd "${WORKDIR}"
if ! [ -d .git ]; then
  git init -q
  git config user.email "org@example.com"
  git config user.name  "org"
  git add -A || true
  git commit -qm "baseline" || true
else
  # ensure at least one commit exists
  git rev-parse --verify HEAD >/dev/null 2>&1 || git commit -qm "baseline (existing .git)"
fi
mkdir -p .org .org/steps

# 3) Export env visible to the app/tools
export ORG_PROJECT_DIR="${WORKDIR}"
export ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}"

# 4) Exec the app (adjust path if your built output is different)
exec bun run dist/app.js "$@"
