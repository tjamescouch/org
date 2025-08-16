#!/usr/bin/env bash
set -euo pipefail

echo "# --- env ---"
: "${OAI_BASE:=http://localhost:11434}"
: "${OAI_MODEL:=mock}"
: "${LOG_LEVEL:=DEBUG}"
: "${SHOW_THINK:=1}"
: "${DEBUG_TRACE:=1}"
: "${SAFE_MODE:=0}"
echo "OAI_BASE=${OAI_BASE}"
echo "OAI_MODEL=${OAI_MODEL}"
echo "LOG_LEVEL=${LOG_LEVEL}"
echo "SHOW_THINK=${SHOW_THINK}"
echo "DEBUG_TRACE=${DEBUG_TRACE}"
echo "SAFE_MODE=${SAFE_MODE}"

# Probe the base (best-effort)
if command -v curl >/dev/null 2>&1; then
  HTTP_CODE=$(curl -sS -m 2 -o /dev/null -w "%{http_code}" "${OAI_BASE}" || true)
  echo "# probe: OAI_BASE=${OAI_BASE} http_code=${HTTP_CODE}"
fi

echo
echo "# running: bun run org.ts --prompt Debug smoke: please exchange greetings and one follow-up. --personas alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
echo

# Always invoke bun explicitly (no #!/usr/bin/env bun).
bun run org.ts \
  --prompt "Debug smoke: please exchange greetings and one follow-up." \
  --personas "alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
