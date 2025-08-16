#!/usr/bin/env bash
set -euo pipefail

# Feel free to tweak these defaults per your local LM Studio / Ollama setup
: "${OAI_BASE:=http://192.168.56.1:11434}"
: "${OAI_MODEL:=gpt-oss:120b}"
: "${LOG_LEVEL:=DEBUG}"
: "${SHOW_THINK:=1}"
: "${DEBUG_TRACE:=1}"
: "${SAFE_MODE:=0}"
: "${PROMPT:=Debug smoke: please exchange greetings and one follow-up.}"
# If you want to try mutex RR later, set SERIALIZE_CHAT=1 before running this script.
: "${SERIALIZE_CHAT:=0}"

echo "# --- env ---"
env | grep -E '^(OAI_BASE|OAI_MODEL|LOG_LEVEL|SHOW_THINK|DEBUG_TRACE|SAFE_MODE|SERIALIZE_CHAT|PROMPT)=' | sort

echo
echo "# running: bun org.ts"
PROMPT="$PROMPT" OAI_BASE="$OAI_BASE" OAI_MODEL="$OAI_MODEL" LOG_LEVEL="$LOG_LEVEL" \
SHOW_THINK="$SHOW_THINK" DEBUG_TRACE="$DEBUG_TRACE" SAFE_MODE="$SAFE_MODE" \
SERIALIZE_CHAT="$SERIALIZE_CHAT" bun org.ts
