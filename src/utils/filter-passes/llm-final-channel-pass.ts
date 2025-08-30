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

const META_TAG_RE = /\[TAG:[^\]]+\]/g;                         // masked tags (ASCII form)
const RAW_TAG_RE  = /@@[A-Za-z0-9_-]+|##[A-Za-z0-9_.\/-]+/g;  // safety net if unprotected

export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };

    let s = this.tail + chunk;
    this.tail = "";
    let out = "";

    let i = 0;
    while (i < s.length) {
      // Preserve fenced blocks verbatim
      if (s.startsWith(FENCE, i)) {
        const j = s.indexOf(FENCE, i + FENCE.length);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + FENCE.length);
        i = j + FENCE.length;
        continue;
      }

      // Find earliest of fence or channel from current index
      const nextChan  = s.indexOf(CHAN, i);
      const nextFence = s.indexOf(FENCE, i);
      let next = -1;
      if (nextChan >= 0 && nextFence >= 0) next = Math.min(nextChan, nextFence);
      else next = Math.max(nextChan, nextFence);

      if (next < 0) {
        // No more tokens. Keep only a STRICT token prefix as carry.
        const carryStart = strictPrefixStart(s, i);
        out += s.slice(i, carryStart);
        this.tail = s.slice(carryStart);
        return { cleaned: out };
      }

      if (next > i) { out += s.slice(i, next); i = next; }

      // Fence case is handled at loop top next iteration
      if (s.startsWith(FENCE, i)) continue;

      // We are at <|channel|>
      const afterChan = i + CHAN.length;
      const msgIdx = s.indexOf(MSG, afterChan);
      if (msgIdx < 0) { this.tail = s.slice(i); return { cleaned: out }; }

      const meta = s.slice(afterChan, msgIdx);
      const payloadStart = msgIdx + MSG.length;
      const nextChan2 = s.indexOf(CHAN, payloadStart);
      const payloadEnd = nextChan2 >= 0 ? nextChan2 : s.length;
      const raw = s.slice(payloadStart, payloadEnd);

      // If it's a JSON payload and it's incomplete across chunks → carry from <|channel|>
      if (/\bjson\b/.test(meta)) {
        const probe = scanJSONObject(s, payloadStart);
        if (!probe.ok) { this.tail = s.slice(i); return { cleaned: out }; }
        // If JSON completes before any next channel, shrink payloadEnd accordingly
        const rawComplete = s.slice(payloadStart, probe.end);
        const prefix = collectMetaTags(meta);
        const unwrapped = extractFromJsonOrEcho(rawComplete) ?? rawComplete;
        out += prefix + unwrapped;
        i = probe.end;  // continue after json object
        continue;
      }

      // commentary payload may also be JSON/echo-like
      if (/commentary/.test(meta)) {
        // Try JSON first; if incomplete, carry
        const probe = scanJSONObject(s, payloadStart);
        if (probe.ok) {
          const rawComplete = s.slice(payloadStart, probe.end);
          const prefix = collectMetaTags(meta);
          const unwrapped = extractFromJsonOrEcho(rawComplete) ?? rawComplete;
          out += prefix + unwrapped;
          i = probe.end;
          continue;
        }
        // Not JSON (or incomplete) → do NOT emit partial commentary; carry
        if (probe.end === s.length) { this.tail = s.slice(i); return { cleaned: out }; }
      }

      // Plain final (no explicit json/commentary) → unwrap immediately
      const prefix = collectMetaTags(meta);
      out += prefix + raw;
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
  return tags.length ? tags.join(" ") + " " : "";
}

function extractFromJsonOrEcho(text: string): string | null {
  const t = String(text ?? "").trim();

  // JSON first
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const v = pickFirstString(j, ["stdout", "output", "message", "result"]);
      if (typeof v === "string") return v;
      if (typeof j?.cmd === "string") {
        const m = j.cmd.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
        if (m) return (m[1] ?? m[2] ?? m[3]) ?? "";
      }
    } catch {}
  }
  // Non-JSON echo
  const m = t.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
  if (m) return (m[1] ?? m[2] ?? m[3]) ?? "";
  return null;
}

function pickFirstString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    if (typeof obj?.[k] === "string") return obj[k];
    if (obj && typeof obj[k] === "object") {
      const deep = pickFirstString(obj[k], keys);
      if (deep) return deep;
    }
  }
  return null;
}

// Earliest index t ≥ i such that s.slice(t) is a STRICT prefix of one token
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

// Balanced, string-aware JSON scan (used for cross-chunk detection)
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
