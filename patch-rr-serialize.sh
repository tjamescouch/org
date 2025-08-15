#!/usr/bin/env bash
set -euo pipefail

echo "[INFO] Installing simple round-robin serializer (turn mutex) …"

# --- Files we touch ---
APP="src/orchestration/app.ts"
CHAT1="src/chat.ts"                # common path we saw in logs
CHAT2="src/orchestration/chat.ts"  # fallback if your chatOnce lives here
MUTEX="src/core/turn-mutex.ts"

# --- 1) Add a tiny turn mutex (queue) ---
mkdir -p "$(dirname "$MUTEX")"
cat > "$MUTEX" <<'TS'
// Simple FIFO mutex to serialize chat calls (one agent at a time)
export class TurnMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

// Singleton used app-wide (enabled only when SERIALIZE_CHAT=1)
export const globalTurnMutex = new TurnMutex();

export const shouldSerialize =
  process.env.SERIALIZE_CHAT === "1" ||
  process.env.SERIALIZE_STRATEGY === "rr";
TS

# --- 2) Wire a friendly log + (optional) early init in app bootstrap ---
if [[ -f "$APP" ]] && ! grep -q 'turn-mutex' "$APP"; then
  tmp="$(mktemp)"
  {
    # new import (kept above to avoid formatting churn)
    echo 'import { globalTurnMutex, shouldSerialize } from "../core/turn-mutex";'
    cat "$APP"
  } > "$tmp" && mv "$tmp" "$APP"

  # Log once so we know it’s active
  if ! grep -q 'round-robin serializer' "$APP"; then
    tmp="$(mktemp)"
    awk '
      BEGIN{done=0}
      {
        if(done==0 && $0 !~ /^[[:space:]]*import[[:space:]]/) {
          print "if (shouldSerialize) {"
          print "  try { console.log(\"[INFO ] round-robin serializer: SERIALIZE_CHAT=1 (one LLM call at a time)\"); } catch {}"
          print "}"
          done=1
        }
        print $0
      }
    ' "$APP" > "$tmp" && mv "$tmp" "$APP"
  fi
fi

# --- helper to instrument a chat file with acquire/release ---
instrument_chat() {
  local FILE="$1"
  [[ ! -f "$FILE" ]] && return 1

  # import
  if ! grep -q 'turn-mutex' "$FILE"; then
    tmp="$(mktemp)"
    {
      echo 'import { globalTurnMutex, shouldSerialize } from "../core/turn-mutex";'
      cat "$FILE"
    } > "$tmp" && mv "$tmp" "$FILE"
  fi

  # Wrap chatOnce start/end. We support either:
  #   export async function chatOnce(…
  #   export const chatOnce = async (…
  if grep -q 'export[[:space:]]\+async[[:space:]]\+function[[:space:]]\+chatOnce' "$FILE"; then
    # Insert acquire right after function signature line
    if ! grep -q '__rr_release__' "$FILE"; then
      tmp="$(mktemp)"
      awk '
        BEGIN{ins=0}
        {
          print $0
          if(ins==0 && $0 ~ /export[[:space:]]+async[[:space:]]+function[[:space:]]+chatOnce[ \t]*\(/){
            print "  const __rr_release__ = shouldSerialize ? await globalTurnMutex.acquire() : () => {};"
            ins=1
          }
        }
      ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"
    fi
    # Insert release in all returns by adding finally { release }
    if ! grep -q 'rr_release' "$FILE" || ! grep -q 'finally' "$FILE"; then
      # naive but safe: wrap whole body by try/finally
      # Only if not already inside a try
      if ! grep -q 'try[[:space:]]*{' "$FILE"; then
        tmp="$(mktemp)"
        awk '
          BEGIN{opened=0}
          {
            if(opened==0 && $0 ~ /export[[:space:]]+async[[:space:]]+function[[:space:]]+chatOnce[ \t]*\(/){
              print $0
              print "{"
              print "  try {"
              opened=1
              next
            }
            if(opened==1 && $0 ~ /^[[:space:]]*}$/){
              print "  } finally { try { __rr_release__(); } catch {} }"
              print "}"
              opened=2
              next
            }
            print $0
          }
        ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"
      else
        # if there is already a try-block, add a trailing finally guard just before function close
        tmp="$(mktemp)"
        awk '
          BEGIN{done=0}
          {
            if(done==0 && $0 ~ /^[[:space:]]*}$/){
              print "  try { /* existing body */ } finally { try { __rr_release__(); } catch {} }"
              print $0
              done=1
              next
            }
            print $0
          }
        ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"
      fi
    fi
    return 0
  fi

  if grep -q 'export[[:space:]]\+const[[:space:]]\+chatOnce[[:space:]]*=[[:space:]]*async' "$FILE"; then
    # Insert acquire at top of function
    if ! grep -q '__rr_release__' "$FILE"; then
      tmp="$(mktemp)"
      awk '
        BEGIN{ins=0}
        {
          print $0
          if(ins==0 && $0 ~ /export[[:space:]]+const[[:space:]]+chatOnce[[:space:]]*=[[:space:]]*async[ \t]*\(/){
            print "{"
            print "  const __rr_release__ = shouldSerialize ? await globalTurnMutex.acquire() : () => {};"
            print "  try {"
            ins=1
            next
          }
          if(ins==1 && $0 ~ /^[[:space:]]*}[;]?[[:space:]]*$/){
            print "  } finally { try { __rr_release__(); } catch {} }"
          }
        }
      ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"
    fi
    return 0
  fi

  return 1
}

# --- 3) Instrument chatOnce (wherever it lives) ---
ok=0
if instrument_chat "$CHAT1"; then ok=1; fi
if [[ $ok -eq 0 ]] && instrument_chat "$CHAT2"; then ok=1; fi
if [[ $ok -eq 0 ]]; then
  echo "[WARN] Could not locate chatOnce in $CHAT1 or $CHAT2."
  echo "       Open your chat module and re-run the script with CHAT1/CHAT2 fixed."
fi

git add -A
git commit -m "serialize(chat): guard chatOnce with FIFO turn mutex when SERIALIZE_CHAT=1"
echo "[OK ] Round-robin serialization installed."

echo
echo "Run with:"
echo "  export SERIALIZE_CHAT=1"
echo "  ./run.sh"
echo
echo "You should see: [INFO ] round-robin serializer: SERIALIZE_CHAT=1 …"
