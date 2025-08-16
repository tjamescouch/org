#!/usr/bin/env bash
set -euo pipefail

say(){ printf '%s\n' "$*" >&2; }

# -----------------------------
# 1) org.ts: add "-" (stdin) mode
#    and keep --prompt working
# -----------------------------
if [[ ! -f org.ts ]]; then
  say "[ERR] org.ts not found (run from repo root)"; exit 1
fi

# Ensure the proper shebang is first, with a blank line after
if [[ "$(head -n1 org.ts || true)" != "#!/usr/bin/env bun" ]]; then
  tmp="$(mktemp)"; {
    echo '#!/usr/bin/env bun'
    echo
    cat org.ts
  } > "$tmp" && mv "$tmp" org.ts
fi

# Insert a tiny argv shim: if user passes "-" we read stdin and inject --prompt
if ! grep -q "/* argv shim: read '-' from stdin */" org.ts; then
  tmp="$(mktemp)"
  {
    head -n2 org.ts
    cat <<'TS'
// /* argv shim: read '-' from stdin */
import { readFileSync } from "node:fs";

(function argvShim(){
  try {
    // If "-" is present, read stdin fully and inject as --prompt
    const wantsStdin = process.argv.includes("-");
    if (wantsStdin) {
      const data = readFileSync(0); // fd 0
      const s = data.toString("utf8");
      const prompt = s.replace(/\r\n/g, "\n");
      // only inject if caller didn't also provide --prompt explicitly
      if (!process.argv.some(a => a === "--prompt")) {
        process.argv.push("--prompt", prompt);
      }
    }
  } catch {}
})();
TS
    tail -n +3 org.ts
  } > "$tmp" && mv "$tmp" org.ts
fi

# -----------------------------
# 2) ChannelLock: add watchdog
#    + stronger telemetry
# -----------------------------
# Try to find the ChannelLock source
LOCK_FILE=""
if [[ -f src/core/channel-lock.ts ]]; then
  LOCK_FILE="src/core/channel-lock.ts"
else
  # fallback: try to locate it
  FOUND="$(grep -RIl --exclude-dir=node_modules -e 'class ChannelLock' src || true)"
  if [[ -n "$FOUND" ]]; then LOCK_FILE="$(echo "$FOUND" | head -n1)"; fi
fi
if [[ -z "${LOCK_FILE}" ]]; then
  say "[WARN] Could not find ChannelLock source. Skipping watchdog patch."
else
  say "[INFO] Patching watchdog into ${LOCK_FILE}"

  # Only patch once
  if ! grep -q "/* watchdog: force-release after max ms */" "$LOCK_FILE"; then
    # 2a) add fields + config after class header
    awk '
      BEGIN{done=0}
      /class[[:space:]]+ChannelLock[[:space:]]*\{/ && done==0 {
        print;
        print "  /* watchdog: force-release after max ms */";
        print "  private __wdTimer: ReturnType<typeof setTimeout> | null = null;";
        print "  private __wdMaxMs: number = Number(process.env.LOCK_MAX_MS ?? \"1500\");";
        print "  private __wdArm(holder: string){";
        print "    if(this.__wdTimer){ clearTimeout(this.__wdTimer); this.__wdTimer = null; }";
        print "    if(this.__wdMaxMs > 0){";
        print "      const ms = this.__wdMaxMs;";
        print "      this.__wdTimer = setTimeout(() => {";
        print "        try {";
        print "          this.logger?.debug?.(`[DEBUG channel-lock] watchdog firing after ${ms}ms; forcibly releasing holder=${holder} queueLength=${this.queue?.length ?? 0}`);";
        print "        } catch {}";
        print "        try {";
        print "          // prefer a safe release path if available";
        print "          // if class provides forceRelease use it; else call release()";
        print "          // @ts-ignore";
        print "          if (typeof this.forceRelease === \"function\") {";
        print "            // @ts-ignore";
        print "            this.forceRelease(\"watchdog\");";
        print "          } else {";
        print "            // @ts-ignore";
        print "            this.release(\"watchdog\");";
        print "          }";
        print "        } catch {}";
        print "        this.__wdTimer = null;";
        print "      }, ms);";
        print "    }";
        print "  }";
        print "  private __wdDisarm(){ if(this.__wdTimer){ clearTimeout(this.__wdTimer); this.__wdTimer=null; } }";
        done=1; next
      }
      { print }
    ' "$LOCK_FILE" > "$LOCK_FILE.tmp" && mv "$LOCK_FILE.tmp" "$LOCK_FILE"

    # 2b) arm on successful acquire (when we flip to locked=true)
    # Try to instrument the first place that sets locked=true
    if ! grep -q "__wdArm(" "$LOCK_FILE"; then
      sed -i '
        /locked[[:space:]]*=[[:space:]]*true/ {
          a \
          try { this.__wdArm(String(holder ?? "unknown")); } catch {}
        }
      ' "$LOCK_FILE"
    fi

    # 2c) disarm on release (where locked=false)
    if ! grep -q "__wdDisarm(" "$LOCK_FILE"; then
      sed -i '
        /locked[[:space:]]*=[[:space:]]*false/ {
          a \
          try { this.__wdDisarm(); } catch {}
        }
      ' "$LOCK_FILE"
    fi

    # 2d) extra defensive logging on release path
    if ! grep -q "\[DEBUG channel-lock\] release" "$LOCK_FILE"; then
      sed -i '
        /release[[:space:]]*\(.*\)\{/,/^\}/ {
          /{/ a \
            try { this.logger?.debug?.(`[DEBUG channel-lock] release called; q=${this.queue?.length ?? 0}`); } catch {}
        }
      ' "$LOCK_FILE"
    fi
  fi
fi

# -----------------------------
# 3) Friendly smoke runner
# -----------------------------
mkdir -p tools
cat > tools/run-smoke-stdin.sh <<'SH'
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
SH
chmod +x tools/run-smoke-stdin.sh

say "[OK] Patch applied."
say "Try a quick run that exercises stdin + watchdog:"
say "  LOCK_MAX_MS=1500 SERIALIZE_CHAT=1 \\\n    OAI_BASE=http://192.168.56.1:11434 OAI_MODEL=gpt-oss:120b \\\n    tools/run-smoke-stdin.sh <<<'Hello'"
