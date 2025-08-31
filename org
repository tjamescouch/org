#!/usr/bin/env bash
# ./org  — host wrapper to run the single-container session.
# Ensures the repo is mounted at /project, /work is primed by entrypoint, and
# ORG_DEFAULT_CWD points to the same subdir you launched from.
# IMPORTANT: do NOT leak a stray positional to the entrypoint. We only forward "$@".

set -euo pipefail

IMAGE="${IMAGE:-localhost/org-build:debian-12}"

# Resolve repo root (prefer enclosing git repo; else current dir)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve subdir relative to repo root so tools enter /work/<subdir>
CWD_SUB="$(
python3 - <<'PY' "$REPO_ROOT" "$PWD"
import os, sys
root=os.path.realpath(sys.argv[1])
cwd =os.path.realpath(sys.argv[2])
print(os.path.relpath(cwd, root) if cwd.startswith(root+os.sep) else "")
PY
)"

# Effective default cwd inside the container
ORG_DEFAULT_CWD="/work${CWD_SUB:+/$CWD_SUB}"

echo "[host] repo   = ${REPO_ROOT}"
echo "[host] subdir = ${CWD_SUB:-<root>}"
echo "[host] ORG_DEFAULT_CWD = ${ORG_DEFAULT_CWD}"

# Place for run artifacts on host (optional)
mkdir -p "${REPO_ROOT}/.org"

# NOTE: No stray "org" after entrypoint — only forward actual CLI args ($@)
exec podman run --rm -it \
  -v "${REPO_ROOT}:/project:ro,Z" \
  -v "${REPO_ROOT}/.org:/hostrun:rw,Z" \
  -e ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}" \
  -w /work \
  "${IMAGE}" \
  /usr/local/bin/org-entrypoint "$@"
