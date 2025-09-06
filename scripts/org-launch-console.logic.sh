#!/usr/bin/env bash
# org-launch-console.logic.sh — container-first console launcher
set -Eeuo pipefail

# Prepare workspace once
workdir-sync-from-project.sh

ORG_DIR="${ORG_RUNTIME_DIR:-/work/.org}"
LOG_DIR="${ORG_DIR}/logs"
LOG_FILE="${LOG_DIR}/console.log"
mkdir -p "${LOG_DIR}"

BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/work/src/app.ts}"

# Tools always run "locally" (i.e., inside this container)
export SANDBOX_BACKEND="none"

# We never apply patches inside the container
APP_FLAGS=(--ui console --review never)

{
  echo "===== org console start: $(date -Is) ====="
  echo "CWD: $(pwd)"
  echo "ENTRY: ${APP_ENTRY}"
  echo "ARGS: $*"
} | tee -a "${LOG_FILE}"

set +e
# Ensure we run from /work so `ls` shows the project
cd /work
"${BUN_BIN}" "${APP_ENTRY}" "${APP_FLAGS[@]}" "$@" 2>&1 | tee -a "${LOG_FILE}"
code=${PIPESTATUS[0]}
set -e

# Synthesize a patch from /work differences
/scripts/patch-create.sh --out "${ORG_DIR}/last-session.patch" || true

echo "===== org console exit: ${code} @ $(date -Is) =====" | tee -a "${LOG_FILE}"
echo "Patch (if any): ${ORG_DIR}/last-session.patch" | tee -a "${LOG_FILE}"
exit "${code}"
