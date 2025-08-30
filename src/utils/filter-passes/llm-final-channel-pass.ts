// src/utils/filter-passes/llm-final-channel-pass.ts
//
// FinalChannelPass: replace outside-fence
//   <|channel|>final ... <|message|>PAYLOAD
// with just PAYLOAD, unwrapping both "commentary" and "json" styles.
//
// Handles:
// - commentary JSON with stdout/output/message/result
// - commentary echo (echo "...")   -> extracts quoted text
// - json blocks { "cmd": "echo \"...\"" } -> extracts quoted text
//
// Preserves fenced code blocks verbatim.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const CHAN = "<|channel|>";
const MSG  = "<|message|>";
const FENCE = "```";

export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    let s = this.tail + chunk;
    this.tail = "";

    let out = "";

    while (s.length > 0) {
      // Preserve fenced blocks
      if (s.startsWith(FENCE)) {
        const j = s.indexOf(FENCE, FENCE.length);
        if (j < 0) { this.tail = s; return { cleaned: out }; }
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

      // Emit preface up to channel
      if (start > 0) {
        out += s.slice(0, start);
        s = s.slice(start);
      }

      // We are at "<|channel|>"
      const afterChan = CHAN.length;
      const msgIdx = s.indexOf(MSG, afterChan);
      if (msgIdx < 0) { this.tail = s; return { cleaned: out }; }

      // Meta is content between channel and message
      const meta = s.slice(afterChan, msgIdx).toLowerCase();
      const payloadStart = msgIdx + MSG.length;

      // Only unwrap "final" meta; otherwise print the token and advance
      if (!/final/.test(meta)) {
        out += s[0]!;
        s = s.slice(1);
        continue;
      }

      // Grab payload up to the next <|channel|> or end
      const nextChan = s.indexOf(CHAN, payloadStart);
      const payloadEnd = nextChan >= 0 ? nextChan : s.length;
      const raw = s.slice(payloadStart, payloadEnd);

      // Unwrap commentary/json payload
      out += unwrapFinalPayload(meta, raw);
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

// ---- helpers ----

function unwrapFinalPayload(meta: string, raw: string): string {
  const looksCommentary = /commentary/.test(meta);
  const looksJSON       = /\bjson\b/.test(meta);

  // Try commentary JSON fields first if meta says commentary
  if (looksCommentary) {
    const text = raw.trimStart();
    const extracted = extractFromJsonOrEcho(text);
    if (extracted != null) return extracted;
    return raw;
  }

  // The model often sends final→json with {"cmd":"echo \"…\""}
  if (looksJSON) {
    const text = raw.trimStart();
    const extracted = extractFromJsonOrEcho(text);
    if (extracted != null) return extracted;
    return raw;
  }

  // Fallback: leave raw payload if neither commentary nor json obvious
  return raw;
}

function extractFromJsonOrEcho(text: string): string | null {
  // 1) JSON object with stdout/output/message/result OR {"cmd": "..."}
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      // Prefer stdout-like fields, then message-like
      const v = pickFirstString(j, ["stdout", "output", "message", "result"]);
      if (typeof v === "string") return v;

      // Or a shell echo string
      if (typeof j?.cmd === "string") {
        const m = j.cmd.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
        if (m) return (m[1] ?? m[2] ?? m[3]) ?? "";
      }
    } catch {
      // fall through to regex echo
    }
  }

  // 2) Non-JSON echo "..."/'...'/bare
  const m = t.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
  if (m) return (m[1] ?? m[2] ?? m[3]) ?? "";

  return null;
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
