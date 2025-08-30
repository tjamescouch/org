// src/utils/filter-passes/llm-noise-filter-first-pass.ts
//
// First pass: historical sentinel & fence logic with ONE intentional change:
// **final** channel blocks are NOT removed here; they flow to FinalChannelPass.
//

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const TAIL_WINDOW = 128;
const CH_TOKEN = "<|channel|>";
const MSG_TOKEN = "<|message|>";
const FENCE = "```";

export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
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

function stripSentinelsPreservingFences(
  s: string
): { cleaned: string; carry: string; removed: number } {
  const parts: string[] = [];
  const n = s.length;
  let i = 0;
  let removed = 0;

  while (i < n) {
    if (s.startsWith(FENCE, i)) {
      const j = s.indexOf(FENCE, i + FENCE.length);
      if (j < 0) break;
      parts.push(s.slice(i, j + FENCE.length));
      i = j + FENCE.length;
      continue;
    }

    const start = s.indexOf(CH_TOKEN, i);
    if (start < 0) {
      const carryStart = findPossiblePrefixStart(s, i, n);
      parts.push(s.slice(i, carryStart));
      i = carryStart;
      break;
    }

    if (start > i) parts.push(s.slice(i, start));

    const metaStart = start + CH_TOKEN.length;
    const msgTag = s.indexOf(MSG_TOKEN, metaStart);
    if (msgTag < 0) {
      i = start;
      break;
    }

    // DO NOT remove final blocks here
    const meta = s.slice(metaStart, msgTag);
    if (/^\s*final\b/i.test(meta)) {
      parts.push(s[start]!);
      i = start + 1;
      continue;
    }

    const p = msgTag + MSG_TOKEN.length;

    const scan = scanJSONObject(s, p);
    if (scan.ok) {
      i = scan.end;
      removed++;
      continue;
    }

    const nl = s.indexOf("\n", p);
    if (nl < 0) {
      i = start;
      break;
    }

    i = nl + 1;
    removed++;
  }

  const cleaned = parts.join("");
  const carry = s.slice(i);
  return { cleaned, carry, removed };
}

function findPossiblePrefixStart(s: string, i: number, n: number): number {
  const windowStart = Math.max(i, n - TAIL_WINDOW);
  for (let t = windowStart; t < n; t++) {
    const suf = s.slice(t);
    if (
      "<|channel|>".startsWith(suf) ||
      "<|message|>".startsWith(suf) ||
      "```".startsWith(suf)
    ) {
      return t;
    }
  }
  return n;
}

function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
  while (i < n && /\s/.test(s[i]!)) i++;
  if (s[i] !== "{") return { ok: false, end: i };

  let depth = 0,
    inStr = false,
    esc = false;

  for (; i < n; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
    } else {
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") {
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth === 0) return { ok: true, end: i + 1 };
      }
    }
  }
  return { ok: false, end: n };
}
