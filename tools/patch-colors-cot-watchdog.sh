#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# 1) ANSI-safe CoT flattener that also wraps stdout.write
# ─────────────────────────────────────────────────────────
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/think-flatten.ts <<'TS'
import { C } from "../ui/colors";

/**
 * Flattens one-token-per-line CoT into a single line.
 * ANSI-safe (we strip color before header detection) and
 * also intercepts process.stdout.write.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    write: process.stdout.write.bind(process.stdout) as (chunk: any, ...args: any[]) => boolean,
  };

  let inThink = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 180);
  };

  const headerRe = /^\*{4}\s+\S+\s+@\s+.+?:\s*$/; // **** alice @ 12:34:56 AM:
  const isHeader = (s: string) => headerRe.test(stripAnsi(s).trim());

  const isTinyToken = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (/^\[(DEBUG|INFO|WARN|ERROR)\]/.test(t)) return false;
    if (/^(assistant|user):/.test(t)) return false;
    return /^[A-Za-z0-9’'\-.,:;()]+$/.test(t) && t.split(/\s+/).length <= 3;
  };

  const flatten = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const line = flatten(buf);
    buf = [];
    if (!line) return;
    const fuchsia = (C.think ?? C.debug ?? "\x1b[38;5;171m");
    orig.log(fuchsia + line + (C.reset ?? "\x1b[0m"));
  };

  const wrapConsole = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;
      if (isHeader(s)) { flush(); inThink = true; return orig[kind](s); }
      if (inThink && isTinyToken(s)) { buf.push(stripAnsi(s)); resetTimer(); return; }
      if (inThink) { flush(); inThink = false; }
    }
    return orig[kind](...args);
  };

  console.log = wrapConsole("log");
  console.info = wrapConsole("info");
  console.warn = wrapConsole("warn");
  console.error = wrapConsole("error");

  // Intercept low-level streaming too (some streams use write directly)
  process.stdout.write = function (chunk: any, ...args: any[]) {
    try {
      const s = typeof chunk === "string" ? chunk : (chunk?.toString?.() ?? "");
      const lines = s.split(/\r?\n/);
      if (lines.length === 1) {
        const one = lines[0];
        if (isHeader(one)) { flush(); inThink = true; return orig.write(chunk, ...args); }
        if (inThink && isTinyToken(one)) { buf.push(stripAnsi(one)); resetTimer(); return true; }
        if (inThink) { flush(); inThink = false; }
        return orig.write(chunk, ...args);
      } else {
        // multi-line: handle each line
        let wrote = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length === 0 && i === lines.length - 1) break;
          if (isHeader(line)) { flush(); inThink = true; orig.write(line + "\n"); wrote = true; continue; }
          if (inThink && isTinyToken(line)) { buf.push(stripAnsi(line)); resetTimer(); continue; }
          if (inThink) { flush(); inThink = false; }
          orig.write(line + "\n"); wrote = true;
        }
        return wrote || true;
      }
    } catch {
      return orig.write(chunk, ...args);
    }
  } as any;

  process.on("exit", flush);
})();
TS

# Ensure the flattener loads first in app bootstrap.
awk '
  NR==1 && $0 !~ /runtime-fixes\/think-flatten/ { print "import \"../runtime-fixes/think-flatten\";" }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts


# ─────────────────────────────────────────────────────────
# 2) Muted color palette override (non-invasive)
#    We override object fields on C at runtime.
# ─────────────────────────────────────────────────────────
cat > src/runtime-fixes/muted-colors.ts <<'TS'
import { C } from "../ui/colors";
// Darker, more muted palette
const X: any = C as any;
X.reset = "\x1b[0m";
X.debug = "\x1b[38;5;245m";      // dim gray
X.info  = "\x1b[38;5;244m";      // a bit darker
X.warn  = "\x1b[38;5;214m";      // amber (muted)
X.error = "\x1b[38;5;203m";      // muted red
X.think = "\x1b[38;5;171m";      // fuchsia but not neon
X.persona   = "\x1b[38;5;110m";  // slate/teal
X.user      = "\x1b[38;5;117m";  // softened cyan
X.assistant = "\x1b[38;5;153m";  // muted violet
TS

awk '
  NR==1 && $0 !~ /runtime-fixes\/muted-colors/ { print "import \"../runtime-fixes/muted-colors\";" }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts


# ─────────────────────────────────────────────────────────
# 3) Stronger lock watchdog:
#    - starts counting when it notices locked && !heldSince
#    - still forces release if queue > 0 and held too long
# ─────────────────────────────────────────────────────────
cat > src/core/debug-hooks.ts <<'TS'
export async function installDebugHooks(): Promise<void> {
  const MAX = Number(process.env.LOCK_MAX_MS ?? 1300);

  try {
    const mod: any = await import("../core/channel-lock");
    const proto = mod?.ChannelLock?.prototype;
    if (!proto || proto.__orgPatched) return;

    // Ensure a per-instance watchdog
    const ensureWatchdog = (self: any) => {
      if (self.__watchdog) return;
      self.__watchdog = setInterval(() => {
        // Start clock lazily if we notice a held lock with queue
        if (self.locked && !self.__heldSince) self.__heldSince = Date.now();
        if (self.locked && self.queue && self.queue.length > 0 && self.__heldSince) {
          const age = Date.now() - self.__heldSince;
          if (age > MAX) {
            console.debug(`[DEADLOCK] channel-lock held for ${age}ms with queueLength=${self.queue.length}. Forcibly releasing.`);
            self.locked = false;
            self.__heldSince = null;
            const next = self.queue.shift();
            if (typeof next === "function") { try { next(); } catch {} }
          }
        }
      }, Math.min(MAX, 500));
    };

    const origAcquire = typeof proto.acquire === "function" ? proto.acquire : undefined;
    const unlockName = ["unlock", "release", "free", "unlockAsync"].find(n => typeof proto[n] === "function");
    const origUnlock = unlockName ? proto[unlockName] : undefined;

    if (origAcquire) {
      proto.acquire = function (...args: any[]) {
        ensureWatchdog(this);
        const out = origAcquire.apply(this, args);
        // Try to start clock soon after acquire (covers immediate case)
        setTimeout(() => { if (this.locked && !this.__heldSince) this.__heldSince = Date.now(); }, 0);
        return out;
      };
    }

    if (origUnlock) {
      proto[unlockName!] = function (...args: any[]) {
        this.__heldSince = null;
        const out = origUnlock.apply(this, args);
        return out;
      };
    }

    proto.__orgPatched = true;
    console.info("debug-hooks: ChannelLock watchdog active (MAX", MAX, "ms)");
  } catch (e) {
    console.warn("debug-hooks: ChannelLock patch skipped:", (e as any)?.message ?? e);
  }
}
TS

# Make sure debug-hooks is imported when DEBUG_TRACE=1
awk '
  NR==1 && $0 !~ /installDebugHooks/ { print "import { installDebugHooks } from \"../core/debug-hooks\";"; }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts

echo "✅ Patch applied: muted colors, ANSI-safe CoT flattening (incl. stdout.write), stronger lock watchdog"
