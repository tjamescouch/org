#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# 1) CoT flattener (runtime, non-invasive): wraps console.* to coalesce the
#    "haiku" token stream printed right after "**** <agent> @ <time>:".
# ──────────────────────────────────────────────────────────────────────────────
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/think-flatten.ts <<'TS'
import { C } from "../ui/colors";

/**
 * Coalesces the single-token lines that appear immediately after
 * "**** <agent> @ ..." into a single flattened line (fuchsia/pink),
 * then lets normal content flow.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  let inThinkBlock = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 250);
  };

  const isTinyFragment = (s: string) => {
    const t = s.trim();
    if (!t) return false;
    // Skip diagnostics and headers.
    if (t.startsWith("[DEBUG]") || t.startsWith("[INFO ") || t.startsWith("[WARN ") || t.startsWith("[ERROR]")) return false;
    if (t.startsWith("assistant:") || t.startsWith("user:")) return false;
    // Very short tokens typical of streamed CoT.
    return /^[A-Za-z0-9'’\-.,:;()]+$/.test(t) && t.length <= 24;
  };

  const flatten = (parts: string[]) =>
    parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return;
    const line = flatten(buf);
    buf = [];
    if (line) {
      const colored = (C.think ?? C.debug ?? "") + line + (C.reset ?? "");
      orig.log(colored);
    }
  };

  const startBlockIfHeader = (s: string) => {
    // Example header: "**** alice @ 2:12:52 AM:"
    return /^\*{4}\s+\S+\s+@\s+.+?:\s*$/.test(s.trim());
  };

  const wrap = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;

      // If we see the header, we *begin* a CoT block.
      if (startBlockIfHeader(s)) {
        flush();               // flush any previous block
        inThinkBlock = true;   // begin new block
        return orig[kind](s);  // pass header through
      }

      // While in a CoT block, collect tiny fragments.
      if (inThinkBlock && isTinyFragment(s)) {
        buf.push(s.trim());
        resetTimer();          // coalesce bursts
        return;                // suppress immediate printing
      }

      // Reaching a "normal" line: first flush CoT, then pass through.
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

# ──────────────────────────────────────────────────────────────────────────────
# 2) Wire the flattener in early app bootstrap (no-op unless SHOW_THINK=1).
# ──────────────────────────────────────────────────────────────────────────────
awk '
  NR==1 && $0 !~ /runtime-fixes\/think-flatten/ {
    print "import \"../runtime-fixes/think-flatten\";";
  }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts

# ──────────────────────────────────────────────────────────────────────────────
# 3) Nudge the scheduler after each completed turn so Bob gets a chance.
#    (If this file already had a wake/kick, we add an idempotent one.)
# ──────────────────────────────────────────────────────────────────────────────
if grep -q "class TurnManager" src/core/turn-manager.ts 2>/dev/null; then
  awk '
    NR==1 { print; next }
    /class TurnManager/ && !printedWake {
      print;
      print "  private __kickPending = false;";
      print "  private __kickSoon() {";
      print "    if (this.__kickPending) return;";
      print "    this.__kickPending = true;";
      print "    setTimeout(() => { this.__kickPending = false; try { this.run?.(); } catch {} }, 0);";
      print "  }";
      printedWake=1; next
    }
    /await agent\.takeTurn/ && !patchedTake {
      print;
      print "      // ensure next agent gets scheduled promptly";
      print "      this.__kickSoon();";
      patchedTake=1; next
    }
    { print }
  ' src/core/turn-manager.ts > src/core/turn-manager.ts.__tmp__ && mv src/core/turn-manager.ts.__tmp__ src/core/turn-manager.ts || true
fi

# ──────────────────────────────────────────────────────────────────────────────
# 4) Fix logger test: assert env-driven getLogLevel instead of setLevel.
# ──────────────────────────────────────────────────────────────────────────────
if [ -f test/logger-level.test.ts ]; then
  cat > test/logger-level.test.ts <<'TS'
import { getLogLevel } from "../src/logger";

describe("Logger respects LOG_LEVEL env", () => {
  const saved = process.env.LOG_LEVEL;
  afterAll(() => { if (saved === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved; });

  test("DEBUG", () => {
    process.env.LOG_LEVEL = "DEBUG";
    expect(getLogLevel()).toBe("DEBUG");
  });

  test("INFO", () => {
    process.env.LOG_LEVEL = "INFO";
    expect(getLogLevel()).toBe("INFO");
  });

  test("fallback", () => {
    process.env.LOG_LEVEL = "NOPE";
    expect(getLogLevel()).toBe("INFO");
  });
});
TS
fi

echo "✅ Patch applied: CoT flattener + scheduler nudge + logger test fix"
