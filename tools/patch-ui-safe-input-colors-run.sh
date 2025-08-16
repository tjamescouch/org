#!/usr/bin/env bash
set -euo pipefail

# ---------- 0) Colors (muted palette) ----------
mkdir -p src/ui
cat > src/ui/colors.ts <<'TS'
export const C = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",

  // muted/darker
  debug: "\x1b[38;5;244m",   // mid grey
  info:  "\x1b[38;5;245m",   // light grey
  warn:  "\x1b[38;5;178m",   // amber
  error: "\x1b[38;5;160m",   // red

  // roles
  user:       "\x1b[38;5;252m",
  assistant:  "\x1b[38;5;250m",

  // chain-of-thought (darker fuchsia)
  think: "\x1b[38;5;125m"
} as const;

export function colorOn(): boolean {
  return process.env.NO_COLOR !== "1";
}
TS

# ---------- 1) Logger tinting ----------
# (keeps your existing API; only tints prefixes if coloring is enabled)
if [ -f src/logger.ts ]; then
  awk 'BEGIN{p=1}
  /export class Logger/ { p=0 } {print}
  END{}' src/logger.ts >/dev/null 2>&1 || true
fi

# Replace/augment logger with colored prefixes while preserving its public API
cat > src/logger.ts <<'TS'
import { C, colorOn } from "./ui/colors";

type Lvl = "DEBUG"|"INFO"|"WARN"|"ERROR";
const want = (lvl: Lvl) => {
  const env = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  const order: Record<Lvl,number> = { DEBUG:10, INFO:20, WARN:30, ERROR:40 };
  return order[lvl] >= (order[env as Lvl] ?? 20);
};
const tint = (lvl: Lvl, s: string) => {
  if (!colorOn()) return s;
  const map: Record<Lvl,string> = { DEBUG:C.debug, INFO:C.info, WARN:C.warn, ERROR:C.error };
  return `${map[lvl]}${s}${C.reset}`;
};

export class Logger {
  static debug(...a: any[]) { if (want("DEBUG")) console.log(tint("DEBUG","[DEBUG]"), ...a); }
  static info (...a: any[]) { if (want("INFO" )) console.log(tint("INFO" ,"[INFO ]"), ...a); }
  static warn (...a: any[]) { if (want("WARN" )) console.warn(tint("WARN" ,"[WARN ]"), ...a); }
  static error(...a: any[]) { if (want("ERROR")) console.error(tint("ERROR","[ERROR]"), ...a); }
}
TS

# ---------- 2) Robust key input (i / s / q) ----------
cat > src/ui/key-input.ts <<'TS'
import { Logger } from "../logger";

export interface KeyHandlers {
  onInterject?: () => void;
  onSendSystem?: () => void;
  onQuit?: () => void;
}

export function setupKeyInput(h: KeyHandlers) {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    Logger.debug("key-input: stdin is not a TTY; interactive keys disabled");
    return { close(){} };
  }

  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
    // CTRL-C
    if (buf.length === 1 && buf[0] === 3) { Logger.info("key-input: ^C"); h.onQuit?.(); return; }
    // Enter (ignored here; safe-mode wrapper handles it)
    if (s === "\r" || s === "\n") return;

    const ch = s.toLowerCase();
    if (ch === "i") { Logger.info("key-input: i (interject)"); h.onInterject?.(); return; }
    if (ch === "s") { Logger.info("key-input: s (send system)"); h.onSendSystem?.(); return; }
    if (ch === "q") { Logger.info("key-input: q (quit)"); h.onQuit?.(); return; }
    // Debug
    Logger.debug("key-input: raw=", JSON.stringify(s));
  };

  try { stdin.setRawMode(true); } catch {}
  stdin.resume();
  stdin.on("data", onData);
  Logger.info("key-input: ready. keys — i:interject, s:system, q:quit, ^C:quit");

  return {
    close() {
      stdin.off("data", onData);
      try { stdin.setRawMode(false); } catch {}
    }
  };
}
TS

# ---------- 3) Safe-mode runtime wrapper (wait for Enter) ----------
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/safe-mode.ts <<'TS'
import { Logger } from "../logger";
import * as readline from "node:readline";
import * as fs from "node:fs";
import { C, colorOn } from "../ui/colors";

function pulseMsg() {
  return colorOn() ? `${C.debug}[waiting for user input...]${C.reset}` : "[waiting for user input...]";
}

async function waitEnter(prompt: string) {
  const ttyPath = "/dev/tty";
  let input: fs.ReadStream | NodeJS.ReadableStream = process.stdin;
  try { if (fs.existsSync(ttyPath)) input = fs.createReadStream(ttyPath); } catch {}
  const rl = readline.createInterface({ input, output: process.stdout });
  const ms = Math.max(1500, parseInt(process.env.WAIT_PULSE_MS ?? "2000", 10) || 2000);

  console.log(colorOn() ? `${C.info}${prompt}${C.reset}` : prompt);
  const id = setInterval(() => console.log(pulseMsg()), ms);

  await new Promise<void>((resolve) => {
    rl.on("line", () => resolve());
    // Fallback: Enter sometimes arrives as "\r"
    rl.on("close", () => resolve());
  });

  clearInterval(id);
  try { (input as any).close?.(); } catch {}
  rl.close();
}

(async () => {
  if (process.env.SAFE_MODE !== "1") return;

  try {
    const chat = await import("../transport/chat"); // where chatOnce lives
    const orig = (chat as any).chatOnce;
    if (typeof orig !== "function") { Logger.warn("safe-mode: chatOnce not found"); return; }
    if ((chat as any).__safeModeWrapped) return;
    (chat as any).__safeModeWrapped = true;

    (chat as any).chatOnce = async function safeWrapped(...args: any[]) {
      const agent = (args?.[0]?.agent ?? args?.[0]?.name ?? "agent");
      await waitEnter(`(SAFE) Press Enter to let ${agent} talk…  (i/s/q still active)`);
      return await orig.apply(this, args);
    };

    Logger.info("safe-mode: chatOnce is now gated by Enter");
  } catch (e: any) {
    Logger.warn("safe-mode: failed to install:", e?.message ?? e);
  }
})();
TS

# ---------- 4) Ensure role-fix exists (prevents assistant->user regression) ----------
cat > src/runtime-fixes/role-fix.ts <<'TS'
import { Logger } from "../logger";

function coerceArgs(args: any[]) {
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

# ---------- 5) Wire fixes into entrypoints and fix shebang (run-ability) ----------
# Ensure org.ts exists and move shebang to first line.
if [ -f org.ts ]; then
  orig="$(cat org.ts)"
  body="$(printf "%s\n" "$orig" | sed '/^#!\/usr\/bin\/env bun$/d')"

  cat > org.ts <<'TSPFX'
#!/usr/bin/env bun
// bootstrap (inserts BEFORE original code)
import { installDebugHooks } from "./src/core/debug-hooks";
import "./src/runtime-fixes/role-fix";
import "./src/runtime-fixes/safe-mode";
import { Logger } from "./src/logger";
if (process.env.DEBUG_TRACE === "1") {
  installDebugHooks().catch(e => console.error("debug-hooks failed:", e));
}
Logger.info("org: bootstrap", { argv: process.argv.slice(2) });
// --- original file follows ---
TSPFX
  printf "%s" "$body" >> org.ts
  echo "✅ org.ts: shebang fixed + bootstrap wired"
fi

# Also wire role/safe fixes in app.ts (TUI path), idempotent
if [ -f src/orchestration/app.ts ] && ! grep -q 'runtime-fixes/safe-mode' src/orchestration/app.ts; then
  tmp="$(mktemp)"
  {
    echo 'import "../runtime-fixes/role-fix";'
    echo 'import "../runtime-fixes/safe-mode";'
  } > "$tmp"
  cat src/orchestration/app.ts >> "$tmp"
  mv "$tmp" src/orchestration/app.ts
  echo "✅ app.ts: runtime fixes wired"
fi

# ---------- 6) Safer debug runner (keeps SAFE_MODE and prints probe) ----------
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
SAFE_MODE="${SAFE_MODE:-0}"

{
  echo "# --- env ---"
  echo "OAI_BASE=$OAI_BASE"
  echo "OAI_MODEL=$OAI_MODEL"
  echo "LOG_LEVEL=$LOG_LEVEL"
  echo "SHOW_THINK=$SHOW_THINK"
  echo "DEBUG_TRACE=$DEBUG_TRACE"
  echo "SAFE_MODE=$SAFE_MODE"
} | tee "$log"

if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" "$OAI_BASE" || echo ERR)
  echo "# probe: OAI_BASE=$OAI_BASE http_code=$code" | tee -a "$log"
fi
echo | tee -a "$log"

entry="org.ts"
[ -f "$entry" ] || entry="src/orchestration/app.ts"

cmd=(bun run "$entry"
  --prompt "Debug smoke: please exchange greetings and one follow-up."
  --personas "alice#${OAI_MODEL}#[You are concise],bob#${OAI_MODEL}#[You are helpful]"
)
[ "$SAFE_MODE" = "1" ] && cmd+=("--safe")

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

echo "✅ Patch applied. Rebuild may not be necessary; try: bun test && SAFE_MODE=1 ./tools/run-org-debug.sh"
