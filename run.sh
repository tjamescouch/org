#!/usr/bin/env bash








export OAI_BASE=http://192.168.56.1:11434
export OAI_MODEL=openai/gpt-oss-120b
export LOG_LEVEL=DEBUG SHOW_THINK=1 DEBUG_TRACE=1
# Optional: tune watchdog threshold (ms)
export LOCK_MAX_MS=1400

./tools/run-org-debug.sh

