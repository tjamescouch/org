#!/usr/bin/env bash
# scripts/run-org-container.sh
# Usage:
#   ./scripts/run-org-container.sh [--image localhost/org-build:debian-12] [--cwd-sub sub/dir] [--repo REPO_ROOT]
#
# Starts a single container that runs the app and all tools inside it.
# We mount the repo at /project (ro), rsync it to /work (rw), and honor ORG_DEFAULT_CWD (/work/<sub dir>).

set -euo pipefail

IMAGE="${IMAGE:-localhost/org-build:debian-12}"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CWD_SUB="${CWD_SUB:-$(python3 - <<'PY' "$REPO_ROOT" "$PWD"
import os, sys
root=os.path.realpath(sys.argv[1]); cwd=os.path.realpath(sys.argv[2])
print(os.path.relpath(cwd, root) if cwd.startswith(root+os.sep) else "")
PY
)}"

# If you prefer absolute, set ORG_DEFAULT_CWD to "/work" or "/work/<sub>"
ORG_DEFAULT_CWD="/work${CWD_SUB:+/${CWD_SUB}}"

echo "[host] repo   = ${REPO_ROOT}"
echo "[host] subdir = ${CWD_SUB:-<root>}"
echo "[host] cwd    = ${PWD}"
echo "[host] ORG_DEFAULT_CWD = ${ORG_DEFAULT_CWD}"

# Ensure a .org on host to collect runs/patches (optional)
mkdir -p "${REPO_ROOT}/.org"

# Run
exec podman run --rm -it \
  -v "${REPO_ROOT}:/project:ro,Z" \
  -v "${REPO_ROOT}/.org:/hostrun:rw,Z" \
  -e ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}" \
  -w /work \
  "${IMAGE}" \
  /usr/local/bin/org-entrypoint
