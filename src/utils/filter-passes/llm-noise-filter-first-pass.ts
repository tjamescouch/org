// src/utils/llm-noise-filter-first-pass.ts
//
// First pass: historical sentinel & fence logic, with ONE key change:
// **Do not remove `<|channel|>final … <|message|>…` blocks**.
// Those are forwarded to FinalChannelPass.
//
// - Removes non-final toolformer sentinels
// - Preserves fenced code blocks verbatim
// - Streaming carry for partial tokens and incomplete fences

import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";

export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): { cleaned: string; removed: number } {
    const s = this.tail + (chunk ?? "");
    const { cleaned, carry, removed } = stripSentinelsPreservingFences(s);
    this.tail = carry;
    return { cleaned, removed };
  }

  flush(): string {
    const out = this.tail;
    this.tail = "";
    return out;
  }
}

const TAIL_WINDOW = 128;
const CH_TOKEN = "<|channel|>";
const MSG_TOKEN = "<|message|>";
const FENCE = "```";

function stripSentinelsPreservingFences(
  s: string
): { cleaned: string; carry: string; removed: number } {
  const parts: string[] = [];
  const n = s.length;
  let i = 0;
  let removed = 0;

  while (i < n) {
    // Preserve fenced code blocks verbatim.
    if (s.startsWith(FENCE, i)) {
      const j = s.indexOf(FENCE, i + FENCE.length);
      if (j < 0) break; // incomplete fence -> keep whole remainder as carry
      parts.push(s.slice(i, j + FENCE.length));
      i = j + FENCE.length;
      continue;
    }

    // Look for a sentinel start.
    const start = s.indexOf(CH_TOKEN, i);
    if (start < 0) {
      // No sentinel ahead. Emit all except a tiny suffix that *might* be
      // the beginning of CH_TOKEN, MSG_TOKEN, or FENCE split across chunks.
      const carryStart = findPossiblePrefixStart(s, i, n);
      parts.push(s.slice(i, carryStart));
      i = carryStart; // everything from i is carry
      break;
    }

    // Emit prefix up to sentinel.
    if (start > i) parts.push(s.slice(i, start));

    // We have "<|channel|>", require "<|message|>" after it.
    const metaStart = start + CH_TOKEN.length;
    const msgTag = s.indexOf(MSG_TOKEN, metaStart);
    if (msgTag < 0) { i = start; break; } // keep from sentinel start as carry

    // **NEW**: skip final; let FinalChannelPass handle it
    const meta = s.slice(metaStart, msgTag);
    if (/^\s*final\b/i.test(meta)) {
      // Emit a byte to avoid infinite loop; leave the block intact for later pass
      parts.push(s[start]!);
      i = start + 1;
      continue;
    }

    const p = msgTag + MSG_TOKEN.length;

    // Try to consume a following JSON object (balanced, string-aware).
    const scan = scanJSONObject(s, p);
    if (scan.ok) {
      i = scan.end;    // drop entire sentinel
      removed++;
      continue;
    }

    // If JSON is incomplete and no newline is present yet, keep for next chunk.
    const nl = s.indexOf("\n", p);
    if (nl < 0) { i = start; break; }

    // Otherwise drop up to the newline and continue.
    i = nl + 1;
    removed++;
  }

  const cleaned = parts.join("");
  const carry = s.slice(i);    // only what we did NOT emit
  return { cleaned, carry, removed };
}

/** Find earliest index t in [i, n] such that s.slice(t) could start a token. */
function findPossiblePrefixStart(s: string, i: number, n: number): number {
  const windowStart = Math.max(i, n - TAIL_WINDOW);
  for (let t = windowStart; t < n; t++) {
    const suf = s.slice(t);
    if (
      CH_TOKEN.startsWith(suf) ||
      MSG_TOKEN.startsWith(suf) ||
      FENCE.startsWith(suf)
    ) {
      return t; // keep from here as carry
    }
  }
  return n; // no possible prefix -> emit all
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
      if (ch === "{") { depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0) return { ok: true, end: i + 1 };
      }
    }
  }
  return { ok: false, end: n }; // incomplete object
}
