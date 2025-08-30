// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
//
// Removes "toolformer" sentinel blocks, e.g.:
//   <|channel|>commentary to=functions sh<|message|>{"cmd":"echo \"hi\""}
// or non-JSON payload lines.
//
// • If JSON complete → drop entire sentinel.
// • If JSON spans chunks → keep carry from <|channel|> (emit nothing).
// • If payload is non-JSON → drop until newline.
// Fences are preserved verbatim.

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
      // Preserve fenced code verbatim
      if (s.startsWith(FENCE, i)) {
        const j = s.indexOf(FENCE, i + FENCE.length);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + FENCE.length);
        i = j + FENCE.length;
        continue;
      }

      // Earliest of fence or channel
      const nextChan  = s.indexOf(CHAN, i);
      const nextFence = s.indexOf(FENCE, i);
      let next = -1;
      if (nextChan >= 0 && nextFence >= 0) next = Math.min(nextChan, nextFence);
      else next = Math.max(nextChan, nextFence);

      if (next < 0) { out += s.slice(i); return { cleaned: out }; }

      if (next > i) { out += s.slice(i, next); i = next; }

      if (s.startsWith(FENCE, i)) continue; // will be handled on next iteration

      const afterChan = i + CHAN.length;
      const msgIdx = s.indexOf(MSG, afterChan);
      if (msgIdx < 0) { this.tail = s.slice(i); return { cleaned: out }; }

      const meta = s.slice(afterChan, msgIdx);
      const isToolformer = /to\s*=\s*functions\b/.test(meta);
      if (!isToolformer) { out += s[i]!; i += 1; continue; }

      const payloadStart = msgIdx + MSG.length;

      // Try JSON; if incomplete, carry
      const probe = scanJSONObject(s, payloadStart);
      if (probe.ok) { i = probe.end; continue; }

      // Non-JSON: drop until newline if present
      const nl = s.indexOf("\n", payloadStart);
      if (nl >= 0) { i = nl + 1; continue; }

      // Incomplete: carry from here
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

function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
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
