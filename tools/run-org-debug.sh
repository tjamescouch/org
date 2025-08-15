#!/usr/bin/env bash
set -euo pipefail

ts=$(date +%s)
log="logs/org-debug-$ts.log"
mkdir -p logs

export OAI_BASE="${OAI_BASE:-http://localhost:8800}"
export OAI_MODEL="${OAI_MODEL:-mock}"
export LOG_LEVEL="${LOG_LEVEL:-DEBUG}"
export SHOW_THINK="${SHOW_THINK:-1}"
export DEBUG_TRACE="${DEBUG_TRACE:-1}"
SAFE_MODE="${SAFE_MODE:-}"

{
  echo "# --- env ---"
  echo "OAI_BASE=$OAI_BASE"
  echo "OAI_MODEL=$OAI_MODEL"
  echo "LOG_LEVEL=$LOG_LEVEL"
  echo "SHOW_THINK=$SHOW_THINK"
  echo "DEBUG_TRACE=$DEBUG_TRACE"
  echo "SAFE_MODE=${SAFE_MODE:-0}"
} | tee "$log"

if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" "$OAI_BASE" || echo ERR)
  echo "# probe: OAI_BASE=$OAI_BASE http_code=$code" | tee -a "$log"
fi
echo | tee -a "$log"

entry="org.ts"
if [ ! -f "$entry" ]; then
  if   [ -f "src/orchestration/app.ts" ]; then entry="src/orchestration/app.ts"
  elif [ -f "tui.ts" ]; then entry="tui.ts"; fi
fi

cmd=(bun run "$entry"
  --prompt "Debug smoke: please exchange greetings and one follow-up."
  --personas "alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
)
[ "${SAFE_MODE:-0}" = "1" ] && cmd+=("--safe")

echo "# running:" "${cmd[@]}" | tee -a "$log"
echo | tee -a "$log"

if command -v stdbuf >/dev/null 2>&1; then
  stdbuf -oL -eL "${cmd[@]}" 2>&1 | tee -a "$log"
else
  "${cmd[@]}" 2>&1 | tee -a "$log"
fi

echo
echo "# log saved to: $log"
