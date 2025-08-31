#!/usr/bin/env bash
# scripts/run-org-container.sh
# Starts a single container that runs the app & tools inside it.
# We mirror the host repo (REPO_ROOT) to /project (ro), rsync it to /work (rw),
# and honor ORG_DEFAULT_CWD (/work/<subdir>).

set -euo pipefail

IMAGE="${IMAGE:-localhost/org-build:debian-12}"

# Repo root (prefer enclosing git repo; else cwd)
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Subdir relative to the repo root (so inside the container we can cd to /work/<subdir>)
CWD_SUB="${CWD_SUB:-$(
python3 - <<'PY' "$REPO_ROOT" "$PWD"
import os, sys
root=os.path.realpath(sys.argv[1])
cwd =os.path.realpath(sys.argv[2])
print(os.path.relpath(cwd, root) if cwd.startswith(root+os.sep) else "")
PY
)}"

ORG_DEFAULT_CWD="/work${CWD_SUB:+/$CWD_SUB}"

echo "[host] repo   = ${REPO_ROOT}"
echo "[host] subdir = ${CWD_SUB:-<root>}"
echo "[host] ORG_DEFAULT_CWD = ${ORG_DEFAULT_CWD}"

# Ensure a .org on host (optional, for runs/patches)
mkdir -p "${REPO_ROOT}/.org"

# Launch single container; forward CLI args after image to entrypoint
exec podman run --rm -it \
  -v "${REPO_ROOT}:/project:ro,Z" \
  -v "${REPO_ROOT}/.org:/hostrun:rw,Z" \
  -e ORG_DEFAULT_CWD="${ORG_DEFAULT_CWD}" \
  -w /work \
  "${IMAGE}" \
  /usr/local/bin/org-entrypoint "$@"
