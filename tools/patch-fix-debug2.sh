#!/usr/bin/env bash
set -euo pipefail

# 1) Fix wrong import in the multi-agent test
# (use src/core/chat-room instead of src/orchestration/chat-room)
if [ -f test/multi-agent-integration.test.ts ]; then
  sed -i.bak 's#../src/orchestration/chat-room#../src/core/chat-room#g' test/multi-agent-integration.test.ts || true
fi

# 2) Replace the debug runner to avoid 'grep' early-exit and to auto-pick entrypoint
mkdir -p tools logs
cat > tools/run-org-debug.sh <<'RUN'
#!/usr/bin/env bash
set -euo pipefail

ts=$(date +%s)
log="logs/org-debug-$ts.log"

# Defaults (exported so child process and printing see them)
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

# Pick an entrypoint that actually exists
entry="org.ts"
if [ ! -f "$entry" ]; then
  if   [ -f "src/orchestration/app.ts" ]; then entry="src/orchestration/app.ts"
  elif [ -f "tui.ts" ]; then entry="tui.ts"
  fi
fi

cmd=(bun run "$entry"
  --prompt "Debug smoke: please exchange greetings and one follow-up."
  --personas "alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
)

if [ "$SAFE_MODE" = "1" ]; then
  cmd+=("--safe")
fi

echo "# running:" "${cmd[@]}" | tee -a "$log"
echo | tee -a "$log"

if command -v stdbuf >/dev/null 2>&1; then
  stdbuf -oL -eL "${cmd[@]}" 2>&1 | tee -a "$log"
else
  "${cmd[@]}" 2>&1 | tee -a "$log"
fi

echo
echo "# log saved to: $log"
RUN
chmod +x tools/run-org-debug.sh

# 3) Add a tiny startup log so we see the app actually boots
APP="src/orchestration/app.ts"
if [ -f "$APP" ]; then
  # import Logger if missing
  if ! grep -q 'from "../logger"' "$APP"; then
    tmp="$(mktemp)"; printf 'import { Logger } from "../logger";\n' > "$tmp"; cat "$APP" >> "$tmp"; mv "$tmp" "$APP"
  fi
  # after the debug-hooks line, log argv once
  if ! grep -q 'app: bootstrap' "$APP"; then
    awk '
      BEGIN{done=0}
      { print $0
        if (!done && $0 ~ /debug-hooks failed:/) {
          print "Logger.info(\"app: bootstrap\", { argv: process.argv.slice(2) });"
          done=1
        }
      }' "$APP" > "$APP.tmp" && mv "$APP.tmp" "$APP"
  fi
fi

echo "✅ Patch applied: test import corrected, runner hardened, app startup log added."
