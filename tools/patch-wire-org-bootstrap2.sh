#!/usr/bin/env bash
set -euo pipefail

# 0) Ensure role-fix exists
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/role-fix.ts <<'TS'
import { Logger } from "../logger";

function coerceArgs(args: any[]) {
  // receive(msg) OR receive(from, role, content, meta?)
  if (args.length === 1 && typeof args[0] === "object" && args[0]) {
    const m = args[0];
    if (m && m.role === "user" && m.from && m.from !== "User") {
      Logger.debug(`[role-fix] Coercing ${m.from} user→assistant (object)`);
      args[0] = { ...m, role: "assistant" };
    }
  } else if (args.length >= 2) {
    const from = args[0];
    const role = args[1];
    if (role === "user" && from && from !== "User") {
      Logger.debug(`[role-fix] Coercing ${from} user→assistant (positional)`);
      args[1] = "assistant";
    }
  }
  return args;
}

(async () => {
  try {
    const mod = await import("../core/chat-room");
    const CR:any = (mod as any).ChatRoom ?? (mod as any).default ?? mod;
    const P = CR?.prototype ?? CR;
    if (!P || typeof P.receive !== "function") {
      Logger.warn("role-fix: ChatRoom.receive not found; no fix applied");
      return;
    }
    if ((P as any).__roleFixPatched) return;
    (P as any).__roleFixPatched = true;

    const orig = P.receive;
    P.receive = function (...a: any[]) {
      try { a = coerceArgs(a); } catch {}
      return orig.apply(this, a);
    };
    Logger.info("role-fix: ChatRoom.receive patched (non-User user→assistant)");
  } catch (e:any) {
    Logger.warn("role-fix: failed to install:", e?.message ?? e);
  }
})();
TS

# 1) Wire role-fix + debug-hooks at the top of org.ts (if present)
ORG="org.ts"
if [ -f "$ORG" ] && ! grep -q 'runtime-fixes/role-fix' "$ORG"; then
  tmp="$(mktemp)"
  {
    echo 'import { installDebugHooks } from "./src/core/debug-hooks";'
    echo 'import "./src/runtime-fixes/role-fix";'
    echo 'import { Logger } from "./src/logger";'
    echo 'if (process.env.DEBUG_TRACE === "1") {'
    echo '  installDebugHooks().catch(e => console.error("debug-hooks failed:", e));'
    echo '}'
    echo 'Logger.info("org: bootstrap", { argv: process.argv.slice(2) });'
  } > "$tmp"
  cat "$ORG" >> "$tmp"
  mv "$tmp" "$ORG"
  echo "✅ wired role-fix & debug-hooks into org.ts"
else
  echo "ℹ️ org.ts already wired or not present"
fi

# 2) Also wire into src/orchestration/app.ts (covers TUI path)
APP="src/orchestration/app.ts"
if [ -f "$APP" ] && ! grep -q 'runtime-fixes/role-fix' "$APP"; then
  tmp="$(mktemp)"
  echo 'import "../runtime-fixes/role-fix";' > "$tmp"
  cat "$APP" >> "$tmp"
  mv "$tmp" "$APP"
  echo "✅ wired role-fix into src/orchestration/app.ts"
fi

# 3) Replace the debug runner with a version that prints a probe line
mkdir -p tools logs
cat > tools/run-org-debug.sh <<'RUN'
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
RUN
chmod +x tools/run-org-debug.sh

echo "✅ patch complete"
