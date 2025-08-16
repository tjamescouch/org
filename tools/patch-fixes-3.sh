#!/usr/bin/env bash
set -euo pipefail

mkdir -p src/runtime-fixes

# ── 1) Muted, darker palette (keeps symbols but tones them down)
cat > src/runtime-fixes/muted-colors.ts <<'TS'
import { C } from "../ui/colors";
const X: any = C as any;
X.reset = "\x1b[0m";
X.debug = "\x1b[38;5;245m";      // dim gray
X.info  = "\x1b[38;5;244m";
X.warn  = "\x1b[38;5;214m";      // muted amber
X.error = "\x1b[38;5;203m";      // muted red
X.persona   = "\x1b[38;5;110m";  // slate/teal
X.user      = "\x1b[38;5;117m";  // softened cyan
X.assistant = "\x1b[38;5;153m";  // muted violet
X.think     = "\x1b[38;5;171m";  // softer fuchsia
TS

# ── 2) ANSI‑safe CoT flattener (collapses tokens to one fuchsia line)
cat > src/runtime-fixes/think-flatten.ts <<'TS'
import { C } from "../ui/colors";
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

  const headerRe = /^\*{4}\s+\S+\s+@\s+.+?:\s*$/; // **** alice @ 12:34:56 AM:
  const isHeader = (s: string) => headerRe.test(stripAnsi(s).trim());
  const isTiny = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (/^\[(DEBUG|INFO|WARN|ERROR)\]/.test(t)) return false;
    if (/^(assistant|user):/.test(t)) return false;
    return /^[\p{L}\p{N}’'\-.,:;()]+$/u.test(t) && t.split(/\s+/).length <= 3;
  };
  const flatten = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();

  const resetTimer = () => { if (flushTimer) clearTimeout(flushTimer); flushTimer = setTimeout(() => flush(), 160); };
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const line = flatten(buf); buf = [];
    if (!line) return;
    const f = (C.think ?? "\x1b[38;5;171m"), r = (C.reset ?? "\x1b[0m");
    orig.log(f + line + r);
  };

  const wrap = (k: "log"|"info"|"warn"|"error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0];
      if (isHeader(s)) { flush(); inThink = true; return orig[k](s); }
      if (inThink && isTiny(s)) { buf.push(stripAnsi(s)); resetTimer(); return; }
      if (inThink) { flush(); inThink = false; }
    }
    return orig[k](...args);
  };

  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");

  process.stdout.write = function (chunk: any, ...args: any[]) {
    try {
      const s = typeof chunk === "string" ? chunk : (chunk?.toString?.() ?? "");
      const lines = s.split(/\r?\n/);
      const emit = (line: string) => orig.write(line + "\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0 && i === lines.length - 1) break;
        if (isHeader(line)) { flush(); inThink = true; emit(line); continue; }
        if (inThink && isTiny(line)) { buf.push(stripAnsi(line)); resetTimer(); continue; }
        if (inThink) { flush(); inThink = false; }
        emit(line);
      }
      return true;
    } catch { return orig.write(chunk, ...args); }
  } as any;

  process.on("exit", flush);
})();
TS

# ── 3) Robust debug hooks: global ChannelLock registry + chatOnce serialization
cat > src/core/debug-hooks.ts <<'TS'
let INSTALLED = false;

export async function installDebugHooks(): Promise<void> {
  if (INSTALLED) return; INSTALLED = true;
  const lockMax = Number(process.env.LOCK_MAX_MS ?? 1400);
  const chatTimeout = Number(process.env.CHAT_CALL_MAX_MS ?? 25000);
  const serialize = (process.env.SERIALIZE_CHAT ?? "1") !== "0";

  // 3a) ChannelLock watchdog with global registry scan
  try {
    const mod: any = await import("../core/channel-lock");
    const reg: any[] = (mod.__orgRegistry ??= []);
    const proto = mod?.ChannelLock?.prototype;
    if (proto && !proto.__orgPatch) {
      const origAcquire = proto.acquire;
      if (typeof origAcquire === "function") {
        proto.acquire = function (...a: any[]) {
          if (!this.__orgRegistered) { reg.push(this); this.__orgRegistered = true; }
          const p = origAcquire.apply(this, a);
          try { this.__heldSince = Date.now(); } catch {}
          return p;
        };
      }
      const unlockName = ["unlock","release","free","unlockAsync"].find(n => typeof proto[n] === "function");
      if (unlockName) {
        const origUnlock = proto[unlockName];
        proto[unlockName] = function (...a: any[]) {
          this.__heldSince = null;
          return origUnlock.apply(this, a);
        };
      }
      proto.__orgPatch = true;
    }
    if (!mod.__orgSweeper) {
      mod.__orgSweeper = setInterval(() => {
        for (const lk of mod.__orgRegistry as any[]) {
          try {
            if (lk && lk.locked && lk.queue && lk.queue.length > 0) {
              if (!lk.__heldSince) lk.__heldSince = Date.now();
              const age = Date.now() - lk.__heldSince;
              if (age > lockMax) {
                console.debug(`[DEADLOCK] channel-lock held for ${age}ms with queueLength=${lk.queue.length}. Forcibly releasing.`);
                lk.locked = false;
                lk.__heldSince = null;
                const next = lk.queue.shift();
                if (typeof next === "function") { try { next(); } catch {} }
              }
            }
          } catch {}
        }
      }, Math.min(500, lockMax));
      console.info(`debug-hooks: ChannelLock watchdog active (MAX ${lockMax} ms)`);
    }
  } catch (e) {
    console.warn("debug-hooks: ChannelLock watchdog skipped:", (e as any)?.message ?? e);
  }

  // 3b) chatOnce serialization (single flight) with timeout
  try {
    const chatMod: any = await import("../transport/chat");
    if (serialize && chatMod && typeof chatMod.chatOnce === "function" && !chatMod.__orgGated) {
      const orig = chatMod.chatOnce.bind(chatMod);
      let inFlight = false; const waiters: Array<() => void> = [];
      const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (inFlight) await new Promise<void>(r => waiters.push(r));
        inFlight = true;
        try {
          return await Promise.race([
            fn(),
            new Promise<T>((_, rej) => setTimeout(() => rej(new Error("chatOnce timeout")), chatTimeout)),
          ]);
        } finally {
          inFlight = false;
          waiters.shift()?.();
        }
      };
      chatMod.chatOnce = (...a: any[]) => gate(() => orig(...a));
      chatMod.__orgGated = true;
      console.info(`debug-hooks: chatOnce serialized (timeout ${chatTimeout} ms)`);
    }
  } catch (e) {
    console.warn("debug-hooks: serialize chat skipped:", (e as any)?.message ?? e);
  }
}
TS

# ── 4) Single bootstrap module (palette + flattener + hooks)
cat > src/runtime-fixes/bootstrap.ts <<'TS'
import "./muted-colors";
import "./think-flatten";
import { installDebugHooks } from "../core/debug-hooks";
installDebugHooks().catch(e => console.warn("debug-hooks install failed:", e));
TS

# ── 5) Ensure bootstrap runs at BOTH entrypoints (idempotent prepend)
prepend() {
  local f="$1"
  test -f "$f" || return 0
  if ! grep -q 'runtime-fixes/bootstrap' "$f"; then
    { echo 'import "./src/runtime-fixes/bootstrap";'; cat "$f"; } > "$f.__tmp__" && mv "$f.__tmp__" "$f"
  fi
}

prepend "org.ts"
prepend "src/orchestration/app.ts"

echo "✅ Patch applied: bootstrap + palette + CoT flattening + watchdog + serialized chatOnce"
