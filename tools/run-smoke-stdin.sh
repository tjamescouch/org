#!/usr/bin/env bash
set -euo pipefail
: "${OAI_BASE:=http://192.168.56.1:11434}"
: "${OAI_MODEL:=gpt-oss:120b}"
: "${LOG_LEVEL:=DEBUG}"
: "${SHOW_THINK:=1}"
: "${DEBUG_TRACE:=1}"
: "${SAFE_MODE:=0}"
: "${LOCK_MAX_MS:=1500}"
: "${SERIALIZE_CHAT:=1}"

echo "# --- env ---"
env | grep -E '^(OAI_BASE|OAI_MODEL|LOG_LEVEL|SHOW_THINK|DEBUG_TRACE|SAFE_MODE|LOCK_MAX_MS|SERIALIZE_CHAT)=' | sort
echo
echo "# usage: echo 'hello' | $0"
bun org.ts -   # the argv shim will read stdin when "-" is present
