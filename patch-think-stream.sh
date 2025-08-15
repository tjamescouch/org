#!/usr/bin/env bash
set -euo pipefail

echo "[INFO] updating streaming CoT flattener (anchorless) + test"

write() {
  mkdir -p "$(dirname "$1")"
  cat > "$1"
  echo "[OK]  wrote $1"
}

# --- new flattener: anchorless + buffered ------------------------------------
write src/core/utils/stdout-think-flatten.ts <<'TS'
// Anchorless streaming CoT flattener for stdout.
// - Detects "**** name @ time:" header.
// - Collapses short one-word lines that follow (the think prelude) into
//   a single line, until the first "normal" content line appears.
// - Holds the buffer while prelude is incomplete; watchdog prevents hangs.

const ANSI = /\x1B\[[0-9;]*m/g;

function stripAnsi(s: string) { return s.replace(ANSI, ""); }

// Heuristic: a "normal" content line (not a dithering think token)
function isBoundaryLine(raw: string): boolean {
  const s = stripAnsi(raw).trim();
  if (!s) return false;
  // Long-ish and has a space => likely natural sentence (user-visible content)
  if (s.length >= 24 && s.includes(" ")) return true;
  // Or anything that looks like a full sentence.
  if (/[.?!)]$/.test(s) && s.split(/\s+/).length >= 3) return true;
  return false;
}

export function flattenThinkBlockOnce(haystack: string): [string, boolean] {
  const start = haystack.lastIndexOf("**** ");
  if (start < 0) return [haystack, false];

  // Find end of header (newline)
  const headerEnd = haystack.indexOf("\n", start);
  if (headerEnd < 0) return [haystack, false];

  // Scan forward line-by-line to find first boundary line.
  const afterHeader = haystack.slice(headerEnd + 1);
  const lines = afterHeader.split(/\r?\n/);

  let boundaryIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isBoundaryLine(lines[i])) {
      boundaryIdx = i;
      break;
    }
  }
  if (boundaryIdx <= 0) return [haystack, false]; // nothing to flatten or boundary missing

  const thinkLines = lines.slice(0, boundaryIdx);
  const rest = lines.slice(boundaryIdx).join("\n");

  // Collapse the short think lines
  const flattened = thinkLines
    .map(l => stripAnsi(l).trim())
    .filter(Boolean)
    .join(" ");

  const rewritten =
    haystack.slice(0, headerEnd + 1) +
    flattened + "\n" +
    rest;

  return [rewritten, true];
}

export function installStdoutThinkFlatten(): void {
  if (process.env.SHOW_THINK !== "1") return;
  const out: any = process.stdout as any;
  if (out.__orgThinkFlattenInstalled) return;
  out.__orgThinkFlattenInstalled = true;

  const origWrite = process.stdout.write.bind(process.stdout);
  let buf = "";
  let watchdog: NodeJS.Timeout | null = null;

  function setWatchdog() {
    if (watchdog) return;
    // Safety: if boundary never appears, flush after 900ms
    watchdog = setTimeout(() => {
      flush(true);
    }, 900).unref?.();
  }
  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  function insidePrelude(b: string): boolean {
    const start = b.lastIndexOf("**** ");
    if (start < 0) return false;
    const headerEnd = b.indexOf("\n", start);
    if (headerEnd < 0) return true; // saw header start, not newline yet
    // If we can flatten now, we are done; otherwise we are "inside"
    const [, changed] = flattenThinkBlockOnce(b);
    return !changed;
  }

  function flush(force = false) {
    let changed = false;
    let tries = 0;
    do {
      tries++;
      let rewritten; [rewritten, changed] = flattenThinkBlockOnce(buf);
      if (changed) buf = rewritten;
    } while (changed && tries < 3);

    const hold = !force && insidePrelude(buf);
    if (!hold) {
      clearWatchdog();
      if (buf) { origWrite(buf); buf = ""; }
    } else {
      setWatchdog();
    }
  }

  (process.stdout as any).write = function(chunk: any, enc?: any, cb?: any) {
    try {
      const s = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString(enc || "utf8")
        : String(chunk);

      buf += s;

      // Only flush when not inside a prelude; otherwise keep buffering
      if (/\n$/.test(s)) flush(false);
      if (typeof cb === "function") cb();
      return true;
    } catch (e) {
      return origWrite(chunk, enc, cb);
    }
  };

  process.on("beforeExit", () => flush(true));
}
TS

# --- unit test: no 'assistant:' anchor variant --------------------------------
write test/think-flatten-stream.test.ts <<'TS'
import { flattenThinkBlockOnce } from "../src/core/utils/stdout-think-flatten";

test("flattens multi-line CoT prelude without assistant anchor", () => {
  const sample =
`**** alice @ 3:01:00 AM:
We
need
to
respond
with
greeting
and
follow
-up
.
Simple
.
Hello! How are you doing today?`;

  const [rewritten, changed] = flattenThinkBlockOnce(sample);
  expect(changed).toBe(true);
  expect(rewritten).toContain("**** alice @ 3:01:00 AM:");
  expect(rewritten).toMatch(/We need to respond with greeting and follow -up \. Simple \.\nHello! How are you doing today\?/);
});
TS

git add -A
git commit -m "Stdout CoT flattener: anchorless streaming version + unit test" || true
echo "[INFO] done. Now run:  bun test  &&  SHOW_THINK=1 ./run.sh"
