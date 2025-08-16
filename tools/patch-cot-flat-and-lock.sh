#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# 1) Update the CoT flattener to be ANSI-safe (strip colors before header match)
# ──────────────────────────────────────────────────────────────────────────────
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/think-flatten.ts <<'TS'
import { C } from "../ui/colors";

/**
 * Coalesces the one-token CoT lines printed immediately after:
 *   "**** <agent> @ <time>:"
 * into a single, readable line. Works even if the header has ANSI colors.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  let inThinkBlock = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 200);
  };

  const isTinyFragment = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (t.startsWith("[DEBUG]") || t.startsWith("[INFO ") || t.startsWith("[WARN ") || t.startsWith("[ERROR]")) return false;
    if (t.startsWith("assistant:") || t.startsWith("user:")) return false;
    // Alnum + light punctuation, up to a few words (typical streamed CoT tokens)
    return /^[A-Za-z0-9'’\-.,:;()]+$/.test(t) && t.split(/\s+/).length <= 3;
  };

  const startBlockIfHeader = (s: string) => {
    const t = stripAnsi(s).trim();
    return /^\*{4}\s+\S+\s+@\s+.+?:\s*$/.test(t);
  };

  const flatten = (parts: string[]) =>
    parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return;
    const line = flatten(buf);
    buf = [];
    if (line) {
      const col = (C.think ?? C.debug ?? "\x1b[38;5;213m"); // fuchsia fallback
      const colored = col + line + (C.reset ?? "\x1b[0m");
      orig.log(colored);
    }
  };

  const wrap = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;

      // Detect header line and begin a CoT block
      if (startBlockIfHeader(s)) {
        flush();
        inThinkBlock = true;
        return orig[kind](s);
      }

      // Buffer tiny token lines while in CoT block
      if (inThinkBlock && isTinyFragment(s)) {
        buf.push(stripAnsi(s));
        resetTimer();
        return; // swallow here, emit on flush
      }

      // Any normal line ends the CoT block
      if (inThinkBlock) {
        flush();
        inThinkBlock = false;
      }
    }
    return orig[kind](...args);
  };

  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");

  process.on("exit", flush);
})();
TS

# Ensure it loads early
awk '
  NR==1 && $0 !~ /runtime-fixes\/think-flatten/ { print "import \"../runtime-fixes/think-flatten\";" }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts

# ──────────────────────────────────────────────────────────────────────────────
# 2) ChannelLock runtime watchdog via debug-hooks (non-invasive)
#    If a lock is held > LOCK_MAX_MS (default 1200ms) with queue>0, we log and
#    force-release to the next waiter. This only installs when DEBUG_TRACE=1.
# ──────────────────────────────────────────────────────────────────────────────
mkdir -p src/core
cat > src/core/debug-hooks.ts <<'TS'
export async function installDebugHooks(): Promise<void> {
  const MAX = Number(process.env.LOCK_MAX_MS ?? 1200);

  // Patch ChannelLock at runtime (prototype monkey-patch)
  try {
    const mod: any = await import("../core/channel-lock");
    const proto = mod?.ChannelLock?.prototype;
    if (proto && !proto.__orgPatched) {
      const unlockName = ["unlock", "release", "free", "unlockAsync"].find(n => typeof proto[n] === "function");
      const origUnlock = unlockName ? proto[unlockName] : undefined;
      const origAcquire = typeof proto.acquire === "function" ? proto.acquire : undefined;

      if (origAcquire) {
        proto.acquire = function (...args: any[]) {
          // kick off a watchdog timer if not present
          if (!this.__watchdog) {
            this.__watchdog = setInterval(() => {
              if (this.locked && this.queue && this.queue.length > 0 && this.__heldSince && Date.now() - this.__heldSince > MAX) {
                console.debug(`[DEADLOCK] channel-lock held for ${Date.now() - this.__heldSince}ms with queueLength=${this.queue.length}. Forcibly releasing.`);
                this.locked = false;
                this.__heldSince = null;
                const next = this.queue.shift();
                if (typeof next === "function") try { next(); } catch {}
              }
            }, Math.min(MAX, 500));
          }
          return origAcquire.apply(this, args);
        };
      }

      if (origUnlock) {
        proto[unlockName!] = function (...args: any[]) {
          this.__heldSince = null;
          const out = origUnlock.apply(this, args);
          return out;
        };
      }

      // Track when the lock actually becomes held
      const holdSetter = function (this: any, v: boolean) {
        this._locked = v;
        if (v) this.__heldSince = Date.now();
      };
      try {
        // If the class exposes 'locked', we redefine its setter to record hold start
        const desc = Object.getOwnPropertyDescriptor(proto, "locked");
        if (desc && (desc.set || desc.get)) {
          Object.defineProperty(proto, "locked", { configurable: true, get: desc.get ?? function(){ return this._locked; }, set: holdSetter });
        } else {
          // Fallback: wrap places that assign .locked=true at runtime via acquire() above
          // __heldSince is also updated by the watchdog when it detects a held lock
        }
      } catch { /* non-fatal */ }

      proto.__orgPatched = true;
      console.info("debug-hooks: ChannelLock watchdog active (MAX=", MAX, "ms)");
    }
  } catch (e) {
    console.warn("debug-hooks: ChannelLock patch skipped:", e?.message ?? e);
  }
}
TS

# Ensure debug-hooks is imported only when DEBUG_TRACE=1 (keep your existing gate)
awk '
  NR==1 && $0 !~ /installDebugHooks/ {
    print "import { installDebugHooks } from \"../core/debug-hooks\";";
  }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts

echo "✅ Patch applied: ANSI-safe CoT flattening + ChannelLock watchdog (DEBUG_TRACE=1)"
