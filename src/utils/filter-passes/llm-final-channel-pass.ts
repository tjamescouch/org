// src/utils/filter-passes/llm-final-channel-pass.ts
//
// FinalChannelPass: replace outside-fence
//   <|channel|>… <|message|>PAYLOAD
// with just PAYLOAD, unwrapping both "commentary" and "json" styles.
// Meta tags (e.g., @@user) that appear BETWEEN channel/message are preserved.
// Fences ```…``` are preserved verbatim; if a closing fence is missing, keep
// remainder as carry and emit nothing until flush.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

const CHAN  = "<|channel|>";
const MSG   = "<|message|>";
const FENCE = "```";

// [TAG:…] ASCII markers from tag-protect – stream & post-turn share the same form.
const META_TAG_RE = /\[TAG:[^\]]+\]/g;
// Fallback: if the protector missed (split across chunks), accept raw tags too.
const RAW_TAG_RE  = /@@[A-Za-z0-9_-]+|##[A-Za-z0-9_.\/-]+/g;

export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };

    let s = this.tail + chunk;
    this.tail = "";
    let out = "";

    let i = 0;
    while (i < s.length) {
      // If current position starts a fence, copy fenced block verbatim.
      if (s.startsWith(FENCE, i)) {
        const j = s.indexOf(FENCE, i + FENCE.length);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + FENCE.length);
        i = j + FENCE.length;
        continue;
      }

      // Find next interesting token (earliest of fence or channel)
      const nextChan  = s.indexOf(CHAN, i);
      const nextFence = s.indexOf(FENCE, i);

      let next = -1;
      if (nextChan >= 0 && nextFence >= 0) next = Math.min(nextChan, nextFence);
      else next = Math.max(nextChan, nextFence);

      if (next < 0) {
        // No more tokens; keep only a STRICT prefix of a token as carry.
        const carryStart = strictPrefixStart(s, i);
        out += s.slice(i, carryStart);
        this.tail = s.slice(carryStart);
        return { cleaned: out };
      }

      // Emit plain text before the next token.
      if (next > i) {
        out += s.slice(i, next);
        i = next;
      }

      // Handle fence case at 'i' (loop head will copy it).
      if (s.startsWith(FENCE, i)) continue;

      // We're at <|channel|>. Require a <|message|> ahead; else keep from here.
      const afterChan = i + CHAN.length;
      const msgIdx = s.indexOf(MSG, afterChan);
      if (msgIdx < 0) { this.tail = s.slice(i); return { cleaned: out }; }

      // meta: between channel and message
      const meta = s.slice(afterChan, msgIdx);
      const payloadStart = msgIdx + MSG.length;

      // Payload ends at next channel or end of chunk.
      const nextChan2 = s.indexOf(CHAN, payloadStart);
      const payloadEnd = nextChan2 >= 0 ? nextChan2 : s.length;
      const raw = s.slice(payloadStart, payloadEnd);

      // Preserve any tags from meta (masked or raw).
      const prefix = collectMetaTags(meta);
      const cleaned = unwrapFinalPayload(meta, raw);

      out += prefix + cleaned;
      i = payloadEnd;
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

function collectMetaTags(meta: string): string {
  const masked = meta.match(META_TAG_RE) || [];
  const raw    = meta.match(RAW_TAG_RE)  || [];
  const tags = [...masked, ...raw];
  if (!tags.length) return "";
  return tags.join(" ") + " ";
}

function unwrapFinalPayload(meta: string, raw: string): string {
  const looksCommentary = /commentary/.test(meta);
  const looksJSON       = /\bjson\b/.test(meta);

  // commentary JSON → stdout/output/message/result OR echo "..."/'...'
  if (looksCommentary) {
    const text = raw.trimStart();
    const extracted = extractFromJsonOrEcho(text);
    if (extracted != null) return extracted;
    return raw;
  }

  // final→json → {"cmd":"echo \"...\""} or single quotes
  if (looksJSON) {
    const text = raw.trimStart();
    const extracted = extractFromJsonOrEcho(text);
    if (extracted != null) return extracted;
    return raw;
  }

  // Plain final – return message body (meta tags are added by caller).
  return raw;
}

function extractFromJsonOrEcho(text: string): string | null {
  const t = text.trim();

  // 1) JSON – pick stdout/output/message/result; fallback to cmd:echo
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const v = pickFirstString(j, ["stdout", "output", "message", "result"]);
      if (typeof v === "string") return v;

      if (typeof j?.cmd === "string") {
        const m = j.cmd.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
        if (m) return (m[1] ?? m[2] ?? m[3]) ?? "";
      }
    } catch {
      // fall through
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

// Return earliest index t ≥ i such that s.slice(t) is a STRICT prefix of
// <|channel|>, <|message|>, or fence ``` (not whole token; not empty).
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
