// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
//
// Removes "toolformer" sentinel blocks emitted inline, e.g.:
//   <|channel|>commentary to=functions sh<|message|>{"cmd":"echo \"hi\""}
// or the non-JSON form that continues until newline.
//
// Behavior per tests:
//   • If JSON payload is complete in the chunk → drop whole sentinel.
//   • If JSON spans chunks → keep carry from <|channel|> start, emit nothing.
//   • If payload is non-JSON → drop until first '\n' (line-based).
//
// Fences ```…``` are preserved verbatim.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const CHAN  = "<|channel|>";
const MSG   = "<|message|>";
const FENCE = "```";

export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    let s = this.tail + chunk;
    this.tail = "";
    let out = "";

    let i = 0;
    while (i < s.length) {
      // Preserve fenced code verbatim.
      if (s.startsWith(FENCE, i)) {
        const j = s.indexOf(FENCE, i + FENCE.length);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + FENCE.length);
        i = j + FENCE.length;
        continue;
      }

      // Locate the next candidate sentinel
      const nextChan = s.indexOf(CHAN, i);
      if (nextChan < 0) {
        out += s.slice(i);
        return { cleaned: out };
      }
      // Emit text before the sentinel
      if (nextChan > i) {
        out += s.slice(i, nextChan);
        i = nextChan;
      }

      // We are at <|channel|>. Check if meta contains 'to=functions'
      const afterChan = i + CHAN.length;
      const msgIdx = s.indexOf(MSG, afterChan);
      if (msgIdx < 0) { this.tail = s.slice(i); return { cleaned: out }; }

      const meta = s.slice(afterChan, msgIdx);
      const isToolformer = /to\s*=\s*functions\b/.test(meta);
      const payloadStart = msgIdx + MSG.length;

      if (!isToolformer) {
        // Not a toolformer sentinel; emit '<' and advance (so later passes can see it)
        out += s[i]!;
        i += 1;
        continue;
      }

      // Toolformer: try to parse a JSON payload; if complete → drop.
      const jsonScan = scanJSONObject(s, payloadStart);
      if (jsonScan.ok) {
        // Drop from i .. jsonScan.end
        i = jsonScan.end;
        continue;
      }

      // If we saw any non-whitespace before a newline, drop until newline.
      const nl = s.indexOf("\n", payloadStart);
      if (nl >= 0) {
        i = nl + 1; // drop the whole line
        continue;
      }

      // Otherwise we have an incomplete sentinel – carry from here.
      this.tail = s.slice(i);
      return { cleaned: out };
    }

    return { cleaned: out };
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }
}

// JSON scanner used for cross-chunk payloads (string-aware, balanced).
function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
  // Skip whitespace
  while (i < n && /\s/.test(s[i]!)) i++;
  if (s[i] !== "{") return { ok: false, end: i };

  let depth = 0, inStr = false, esc = false;

  for (; i < n; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = false; continue; }
    } else {
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{")  { depth++; continue; }
      if (ch === "}")  { depth--; if (depth === 0) return { ok: true, end: i + 1 }; }
    }
  }
  return { ok: false, end: n };
}
