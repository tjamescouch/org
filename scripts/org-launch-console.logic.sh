#!/usr/bin/env bash
# runtime logic executed inside container for console UI
set -Eeuo pipefail

# Ensure /work mirrors /project once
if command -v workdir-sync-from-project.sh >/dev/null 2>&1; then
  workdir-sync-from-project.sh
fi

export SANDBOX_BACKEND=none   # tools run "locally" inside the container

ORG_DIR="${ORG_RUNTIME_DIR:-/work/.org}"
LOG_DIR="${ORG_DIR}/logs"
LOG_FILE="${LOG_DIR}/console.log"
mkdir -p "${LOG_DIR}"

BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/work/src/app.ts}"

cd /work
set +e
"${BUN_BIN}" "${APP_ENTRY}" --ui console --review never "$@" 2>&1 | tee -a "${LOG_FILE}"
code=${PIPESTATUS[0]}
set -e

# write the patch if helper exists
if [[ -x /scripts/patch-create.sh ]]; then
  /scripts/patch-create.sh --out "${ORG_DIR}/last-session.patch" || true
fi

exit "${code}"
