#!/usr/bin/env bash
# scripts/org-launch-console
# Runs the app in console mode (default) and logs to /work/.org/logs/console.log.
# If user passes --ui=console or --ui=rich, that flag is preserved verbatim.

set -Eeuo pipefail

ORG_DIR="${ORG_RUNTIME_DIR:-/work/.org}"
LOG_DIR="${ORG_DIR}/logs"
LOG_FILE="${LOG_DIR}/console.log"
BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/application/src/app.ts}"

# Forward ALL user args verbatim to the app.
APP_ARGS=("$@")

export SANDBOX_BACKEND="${SANDBOX_BACKEND:-none}"
export ORG_SANDBOX_BACKEND="${ORG_SANDBOX_BACKEND:-none}"
export ORG_EXTERNAL_TMUX_BOOTSTRAP=1
export EDITOR=true VISUAL=true GIT_EDITOR=true PAGER=cat

mkdir -p "${LOG_DIR}"
chmod 700 "${ORG_DIR}" || true

[[ -x "${BUN_BIN}"  ]] || { echo "ERROR: bun not found at ${BUN_BIN}"  >&2; exit 1; }
[[ -f "${APP_ENTRY}" ]] || { echo "ERROR: entrypoint not found: ${APP_ENTRY}" >&2; exit 42; }

# Decide UI mode: if user supplied --ui console|rich, keep it. Else default to console.
UI_MODE="console"
for arg in "${APP_ARGS[@]}"; do
  case "$arg" in
    --ui)        ;; # handled with next value
    --ui=*)      ui_val="${arg#--ui=}" ;;
    *)
      if [[ "$prev" == "--ui" ]]; then
        ui_val="$arg"
      fi
      ;;
  esac
  prev="$arg"
done

if [[ "${ui_val:-}" == "console" || "${ui_val:-}" == "rich" ]]; then
  UI_FLAG=(--ui "$ui_val")
else
  UI_FLAG=(--ui console)
fi

# Helper to print argv safely for logs
print_cmd() {
  printf "%q " "$@"
  printf "\n"
}

{
  echo "===== org console start: $(date -Is) ====="
  printf "cmd: "
  print_cmd "${BUN_BIN}" "${APP_ENTRY}" "${UI_FLAG[@]}" "${APP_ARGS[@]}"
} | tee -a "${LOG_FILE}"

set +e
# Run the app, tee output, preserve the app's exit code
"${BUN_BIN}" "${APP_ENTRY}" "${UI_FLAG[@]}" "${APP_ARGS[@]}" 2>&1 | tee -a "${LOG_FILE}"
code=${PIPESTATUS[0]}
set -e

echo "===== org console exit: ${code} @ $(date -Is) =====" | tee -a "${LOG_FILE}"
exit "${code}"
