#!/usr/bin/env bash
set -euo pipefail

say(){ printf "%s\n" "$*" >&2; }

# --- 1) Shebang fix + auto-prompt shim in org.ts ----------------------------
if [[ ! -f org.ts ]]; then
  say "[ERR] org.ts not found in repo root"; exit 1
fi

say "[1/3] fixing shebang and adding auto-prompt shim in org.ts"

# Remove any existing bun shebang wherever it is (idempotent)
tmp="$(mktemp)"
awk '
  NR==1 && $0 ~ /^#!.*bun/ { next }
  NR>1  && $0 ~ /^#!.*bun/ { next }
  { print }
' org.ts > "$tmp" && mv "$tmp" org.ts

# Prepend correct shebang + blank line if not already the first line
first="$(head -n1 org.ts || true)"
if [[ "$first" != "#!/usr/bin/env bun" ]]; then
  tmp="$(mktemp)"
  {
    echo "#!/usr/bin/env bun"
    echo
    cat org.ts
  } > "$tmp" && mv "$tmp" org.ts
fi

# Insert a tiny argv shim right after the shebang to avoid “hang” when no --prompt
# If PROMPT env var is set, we inject it into process.argv.
if ! grep -q "/* org.ts auto-prompt shim */" org.ts; then
  tmp="$(mktemp)"
  {
    # keep the first two lines (shebang + blank) intact
    head -n2 org.ts
    cat <<'TS'

// /* org.ts auto-prompt shim */  // keeps app functional when run with no args
try {
  // If launched without --prompt but PROMPT is present, inject it.
  const hasPromptArg = process.argv.some(a => a === "--prompt");
  const envPrompt = (process.env.PROMPT || "").trim();
  if (!hasPromptArg && envPrompt.length > 0) {
    process.argv.push("--prompt", envPrompt);
  }
} catch {}

TS
    # then the rest of the file
    tail -n +3 org.ts
  } > "$tmp" && mv "$tmp" org.ts
fi

# --- 2) Small helper: tools/run-smoke.sh ------------------------------------
say "[2/3] adding tools/run-smoke.sh"
mkdir -p tools
cat > tools/run-smoke.sh <<'SH'
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
SH
chmod +x tools/run-smoke.sh

# --- 3) Friendly one-liner smoke alias at repo root -------------------------
say "[3/3] adding run-smoke alias script (./run-smoke)"
cat > run-smoke <<'SH'
#!/usr/bin/env bash
exec tools/run-smoke.sh
SH
chmod +x run-smoke

say "[OK] patch complete. Try:"
say "     ./run-smoke"
say "  or PROMPT='write a haiku' ./run-smoke"
