// src/utils/filter-passes/llm-noise-filter-first-pass.ts
//
// First pass: fence-aware pass-through.
// Guarantee: no stray carry for normal text; preserve fences verbatim.
// Does NOT unwrap channel/message; just prepares safe text for later passes.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const CHAN  = "<|channel|>";
const MSG   = "<|message|>";
const FENCE = "```";

export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };

    let s = this.tail + chunk;
    this.tail = "";
    let out = "";

    let i = 0;
    while (i < s.length) {
      if (s.startsWith(FENCE, i)) {
        const j = s.indexOf(FENCE, i + FENCE.length);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + FENCE.length);
        i = j + FENCE.length;
        continue;
      }

      // Find earliest of channel/message/fence
      const nextFence = s.indexOf(FENCE, i);
      const nextChan  = s.indexOf(CHAN, i);
      const nextMsg   = s.indexOf(MSG, i);

      let next = Number.MAX_SAFE_INTEGER;
      if (nextFence >= 0) next = Math.min(next, nextFence);
      if (nextChan  >= 0) next = Math.min(next, nextChan);
      if (nextMsg   >= 0) next = Math.min(next, nextMsg);

      if (next === Number.MAX_SAFE_INTEGER) {
        const carryStart = strictPrefixStart(s, i);
        out += s.slice(i, carryStart);
        this.tail = s.slice(carryStart);
        return { cleaned: out };
      }

      if (next > i) {
        out += s.slice(i, next);
        i = next;
        continue;
      }

      // We encountered a token; do not modify, just copy one char to advance.
      out += s[i]!;
      i += 1;
    }

    return { cleaned: out };
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }
}

function strictPrefixStart(s: string, i: number): number {
  const n  = s.length;
  const maxLen = Math.max(CHAN.length, MSG.length, FENCE.length) - 1;
  const windowStart = Math.max(i, n - maxLen);

  for (let t = windowStart; t < n; t++) {
    const suf = s.slice(t);
    if (!suf) continue;
    if (isStrictPrefix(suf, CHAN) || isStrictPrefix(suf, MSG) || isStrictPrefix(suf, FENCE)) {
      return t;
    }
  }
  return n;
}

function isStrictPrefix(suf: string, tok: string): boolean {
  return suf.length < tok.length && tok.startsWith(suf);
}
