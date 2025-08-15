#!/usr/bin/env bash
set -euo pipefail

ts=$(date +%s)
mkdir -p logs
log="logs/org-debug-$ts.log"

# You can tweak these defaults
: "${OAI_BASE:=http://localhost:8800}"
: "${OAI_MODEL:=mock}"
: "${LOG_LEVEL:=DEBUG}"
: "${SHOW_THINK:=1}"           # keep CoT visible
: "${DEBUG_TRACE:=1}"          # turn on our runtime hooks
: "${SAFE_MODE:=}"             # set to 1 to add --safe

echo "# --- env ---" | tee "$log"
env | grep -E '^(OAI|LOG_LEVEL|SHOW_THINK|DEBUG_TRACE)=' | sort | tee -a "$log"
echo "# -----------" | tee -a "$log"

cmd=(bun run org.ts
  --prompt "Quick smoke test: please exchange greetings and one follow-up."
  --personas "alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
)

if [ "${SAFE_MODE:-}" = "1" ]; then
  cmd+=("--safe")
fi

echo "# running:" "${cmd[@]}" | tee -a "$log"
echo | tee -a "$log"

# Prefer line-buffered output if available
if command -v stdbuf >/dev/null 2>&1; then
  stdbuf -oL -eL "${cmd[@]}" 2>&1 | tee -a "$log"
else
  "${cmd[@]}" 2>&1 | tee -a "$log"
fi

echo
echo "# log saved to: $log"
