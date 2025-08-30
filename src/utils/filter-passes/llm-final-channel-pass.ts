// src/utils/filter-passes/llm-final-channel-pass.ts
//
// FinalChannelPass: replace outside-fence
//   <|channel|>final ... <|message|>PAYLOAD
// with just PAYLOAD. Unwraps commentary JSON/echo. Preserves trailing \n.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const CHAN = "<|channel|>";
const MSG = "<|message|>";
const FENCE = "```";

export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    let s = this.tail + chunk;
    this.tail = "";

    let out = "";
    while (s.length > 0) {
      if (s.startsWith(FENCE)) {
        const j = s.indexOf(FENCE, FENCE.length);
        if (j < 0) {
          this.tail = s;
          return { cleaned: out };
        }
        out += s.slice(0, j + FENCE.length);
        s = s.slice(j + FENCE.length);
        continue;
      }

      const start = s.indexOf(CHAN);
      if (start < 0) {
        const carryStart = possiblePrefixStart(s);
        out += s.slice(0, carryStart);
        this.tail = s.slice(carryStart);
        return { cleaned: out };
      }

      if (start > 0) {
        out += s.slice(0, start);
        s = s.slice(start);
      }

      const metaStart = CHAN.length;
      const msgIdx = s.indexOf(MSG, metaStart);
      if (msgIdx < 0) {
        this.tail = s;
        return { cleaned: out };
      }

      const meta = s.slice(metaStart, msgIdx).trim();
      const payloadStart = msgIdx + MSG.length;

      if (!/^final\b/i.test(meta)) {
        out += s[0]!;
        s = s.slice(1);
        continue;
      }

      const nextTag = s.indexOf(CHAN, payloadStart);
      const payloadEnd = nextTag >= 0 ? nextTag : s.length;
      const raw = s.slice(payloadStart, payloadEnd);

      out += unwrapCommentary(meta, raw);
      s = s.slice(payloadEnd);
    }

    return { cleaned: out };
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }
}

function unwrapCommentary(meta: string, raw: string): string {
  const looksCommentary =
    /<\|constrain\|\>\s*:?\/commentary\b/i.test(meta) || /commentary\b/i.test(meta);

  if (!looksCommentary) return raw;

  const text = raw.trimStart();
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      const v = pickFirstString(j, ["stdout", "output", "message", "result"]);
      if (typeof v === "string") return v; // keep trailing \n if present
    }
  } catch {
    /* not JSON */
  }

  const m = text.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
  if (m) return (m[1] ?? m[2] ?? m[3]) ?? raw;
  return raw;
}

function pickFirstString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    if (typeof obj?.[k] === "string") return obj[k] as string;
    if (obj && typeof obj[k] === "object") {
      const deep = pickFirstString(obj[k], keys);
      if (deep) return deep;
    }
  }
  return null;
}

function possiblePrefixStart(s: string): number {
  const windowStart = Math.max(0, s.length - 128);
  for (let t = windowStart; t < s.length; t++) {
    const suf = s.slice(t);
    if (CHAN.startsWith(suf) || MSG.startsWith(suf) || FENCE.startsWith(suf)) return t;
  }
  return s.length;
}
