// src/utils/llm-final-channel-pass.ts
//
// FinalChannelPass: outside fences, replace any
//   <|channel|>final ... <|message|>PAYLOAD
// with just PAYLOAD, unwrapping common commentary wrappers (JSON/echo).
//
// Streaming-safe: carries partial <|channel|> or <|message|> tails.
// Fence-aware: anything between ```…``` is passed through verbatim.

const CHAN = "<|channel|>";
const MSG  = "<|message|>";
const FENCE = "```";

export class FinalChannelPass {
  private tail = "";          // carry for partial tags or incomplete fence

  feed(chunk: string): string {
    if (!chunk) return "";
    let s = this.tail + chunk;
    this.tail = "";

    let out = "";
    while (s.length > 0) {
      // Handle fences first: preserve verbatim
      if (s.startsWith(FENCE)) {
        const j = s.indexOf(FENCE, FENCE.length);
        if (j < 0) { this.tail = s; return out; }
        out += s.slice(0, j + FENCE.length);
        s = s.slice(j + FENCE.length);
        continue;
      }

      // Outside fences: look for a channel tag
      const start = s.indexOf(CHAN);
      if (start < 0) {
        // No tag ahead; also keep tiny suffix if it could be the start of a tag or fence
        const carryStart = possiblePrefixStart(s);
        out += s.slice(0, carryStart);
        this.tail = s.slice(carryStart);
        return out;
      }

      // Emit prefix up to the tag
      if (start > 0) {
        out += s.slice(0, start);
        s = s.slice(start);
      }

      // s now begins with CHAN
      const metaStart = CHAN.length;
      const msgIdx = s.indexOf(MSG, metaStart);
      if (msgIdx < 0) { this.tail = s; return out; }

      const meta = s.slice(metaStart, msgIdx).trim();
      const payloadStart = msgIdx + MSG.length;

      if (!/^final\b/i.test(meta)) {
        // Not a final block: leave it untouched but avoid infinite loop by emitting one char
        out += s[0]!;
        s = s.slice(1);
        continue;
      }

      // Find end of this payload = next CHAN or end-of-string
      const nextTag = s.indexOf(CHAN, payloadStart);
      const payloadEnd = nextTag >= 0 ? nextTag : s.length;
      const raw = s.slice(payloadStart, payloadEnd);

      out += this.unwrapCommentary(meta, raw);

      s = s.slice(payloadEnd);
    }

    return out;
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }

  // ---- helpers ----

  private unwrapCommentary(meta: string, raw: string): string {
    const looksCommentary =
      /<\|constrain\|\>\s*:?\/commentary\b/i.test(meta) || /commentary\b/i.test(meta);

    if (!looksCommentary) return raw;

    const text = raw.trimStart();

    // JSON tool wrapper: prefer stdout/output/message/result; PRESERVE trailing newline if present
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object") {
        const v = pickFirstString(j, ["stdout", "output", "message", "result"]);
        if (typeof v === "string") return v;
      }
    } catch { /* not JSON */ }

    // echo "…", echo '…', echo @@user …   (preserve newline)
    const m = text.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
    if (m) return (m[1] ?? m[2] ?? m[3]) ?? raw;

    return raw;
  }
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

/** Find earliest index where a suffix could be the start of a tag or fence. */
function possiblePrefixStart(s: string): number {
  const windowStart = Math.max(0, s.length - 128);
  for (let t = windowStart; t < s.length; t++) {
    const suf = s.slice(t);
    if (CHAN.startsWith(suf) || MSG.startsWith(suf) || FENCE.startsWith(suf)) {
      return t;
    }
  }
  return s.length;
}
