#!/usr/bin/env bash
set -euo pipefail

echo "[INFO] add byte/Unicode debug logging for CoT stream (DEBUG_COT=1)"

mkdir -p src/core/utils logs

cat > src/core/utils/stdout-think-flatten.ts <<'TS'
// Anchorless streaming CoT flattener for stdout, plus optional byte/Unicode logging.
//
// Env:
//   SHOW_THINK=1  -> enable flattener
//   DEBUG_COT=1   -> log raw bytes/codepoints/flush decisions to logs/cot-bytes-*.log

import fs from "fs";

// ---------- helpers ----------
const ANSI = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string) { return s.replace(ANSI, ""); }

// Heuristic: a "normal" content line (not a dithering think token)
function isBoundaryLine(raw: string): boolean {
  const s = stripAnsi(raw).trim();
  if (!s) return false;
  if (s.length >= 24 && s.includes(" ")) return true;
  if (/[.?!)]$/.test(s) && s.split(/\s+/).length >= 3) return true;
  return false;
}

// The main single-pass rewrite
export function flattenThinkBlockOnce(haystack: string): [string, boolean] {
  const start = haystack.lastIndexOf("**** ");
  if (start < 0) return [haystack, false];

  const headerEnd = haystack.indexOf("\n", start);
  if (headerEnd < 0) return [haystack, false];

  const afterHeader = haystack.slice(headerEnd + 1);
  const lines = afterHeader.split(/\r?\n/);

  let boundaryIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isBoundaryLine(lines[i])) { boundaryIdx = i; break; }
  }
  if (boundaryIdx <= 0) return [haystack, false];

  const thinkLines = lines.slice(0, boundaryIdx);
  const rest = lines.slice(boundaryIdx).join("\n");

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

// ---------- DEBUG_COT logging ----------
function makeCotLogger() {
  if (process.env.DEBUG_COT !== "1") return null;
  fs.mkdirSync("logs", { recursive: true });
  const path = `logs/cot-bytes-${Date.now()}.log`;
  const ws = fs.createWriteStream(path, { flags: "a" });
  const t0 = Date.now();
  ws.write(`# CoT byte debug\n# file: ${path}\n`);

  function writeLine(s: string) { ws.write(s + "\n"); }

  function dump(label: string, chunk: any) {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const elapsed = Date.now() - t0;

      const hex = buf.slice(0, 256).toString("hex").replace(/(..)/g, "$1 ").trim();
      const textRaw = Buffer.isBuffer(chunk) ? buf.toString("utf8") : String(chunk);
      const textEsc = textRaw.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      const cps = Array.from(textRaw).slice(0, 80)
        .map(ch => ch.codePointAt(0)!.toString(16))
        .join(" ");

      writeLine(`[${elapsed}ms] ${label} len=${buf.length}`);
      writeLine(`HEX ${hex}`);
      writeLine(`TXT "${textEsc.slice(0,160)}"${textEsc.length>160 ? "…" : ""}`);
      writeLine(`CP  ${cps}`);
    } catch { /* ignore */ }
  }

  function note(msg: string) {
    const elapsed = Date.now() - t0;
    writeLine(`[${elapsed}ms] NOTE ${msg}`);
  }

  return { dump, note, end: () => ws.end() };
}

// ---------- install interceptor ----------
export function installStdoutThinkFlatten(): void {
  if (process.env.SHOW_THINK !== "1") return;

  const out: any = process.stdout as any;
  if (out.__orgThinkFlattenInstalled) return;
  out.__orgThinkFlattenInstalled = true;

  const dbg = makeCotLogger();
  const logDump = dbg ? dbg.dump : (_l:string,_c:any)=>{};
  const logNote = dbg ? dbg.note : (_s:string)=>{};

  const origWrite = process.stdout.write.bind(process.stdout);
  let buf = "";
  let watchdog: NodeJS.Timeout | null = null;

  function setWatchdog() {
    if (watchdog) return;
    watchdog = setTimeout(() => flush(true), 900).unref?.();
  }
  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  function insidePrelude(b: string): boolean {
    const start = b.lastIndexOf("**** ");
    if (start < 0) return false;
    const headerEnd = b.indexOf("\n", start);
    if (headerEnd < 0) return true;
    const [, changed] = flattenThinkBlockOnce(b);
    return !changed;
  }

  function flush(force = false) {
    let changed = false;
    let tries = 0;
    do {
      tries++;
      let rewritten; [rewritten, changed] = flattenThinkBlockOnce(buf);
      if (changed) {
        logNote(`flatten applied (pass ${tries}), +${rewritten.length - buf.length} bytes delta`);
        buf = rewritten;
      }
    } while (changed && tries < 3);

    const hold = !force && insidePrelude(buf);
    if (!hold) {
      clearWatchdog();
      if (buf) {
        logNote(`FLUSH out len=${Buffer.byteLength(buf, "utf8")}`);
        origWrite(buf);
        buf = "";
      }
    } else {
      logNote("HOLD (inside prelude)");
      setWatchdog();
    }
  }

  (process.stdout as any).write = function(chunk: any, enc?: any, cb?: any) {
    try {
      logDump("WRITE.chunk", chunk);

      const s = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString(enc || "utf8")
        : String(chunk);

      buf += s;

      if (/\n$/.test(s)) flush(false);
      if (typeof cb === "function") cb();
      return true;
    } catch {
      return origWrite(chunk, enc, cb);
    }
  };

  process.on("beforeExit", () => { try { flush(true); dbg?.end(); } catch {} });
}

TS

# keep your existing test file(s) — no changes needed here

git add -A
git commit -m "debug(COT): byte/Unicode stream logger + flush/hold notes (DEBUG_COT=1)" || true
echo "[INFO] Patch applied. Use: DEBUG_COT=1 SHOW_THINK=1 ./run.sh ; then open logs/cot-bytes-*.log"
