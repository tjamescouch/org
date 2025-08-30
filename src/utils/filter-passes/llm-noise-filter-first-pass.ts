// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * First pass: fast & stream-safe cleanup of obvious single-token sentinels.
 *
 * Responsibilities
 *  - Drop tokens like <|constrain|>, <|endoftext|>, <|channel|> etc.
 *  - Special-case: <|channel|>TOKEN removes the channel TOKEN (e.g. "final").
 *  - Special-case: <|message|> becomes a single space to separate role header from text.
 *  - Strip zero-width & control chars (but keep \t, \r, \n).
 *  - Never leak partial "<" or "<|" across chunk boundaries (buffer tail).
 */
export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";
  // If the previous chunk ended right after <|channel|>, we must consume the channel name
  private pendingChannelWord = false;

  feed(chunk: string): PassFeedResult {
    let buf = (this.tail ?? "") + (chunk ?? "");
    const before = buf.length;
    let removed = 0;

    // 0) Remove zero width / control characters (except \t, \n, \r)
    const zBefore = buf.length;
    buf = buf
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    removed += zBefore - buf.length;

    // 1) If last chunk ended with <|channel|>, consume the channel word here.
    if (this.pendingChannelWord) {
      const eaten = this.consumeLeadingChannelWord(buf);
      if (eaten > 0) {
        buf = buf.slice(eaten);
        removed += eaten;
        this.pendingChannelWord = false;
      } else {
        // still waiting for the word to complete
        this.tail = (this.tail ?? "") + (chunk ?? "");
        return { cleaned: "", removed };
      }
    }

    // 2) <|message|> → single space
    buf = buf.replace(/<\|message\|>/gi, " ");

    // 3) Remove <|channel|> + immediate channel word (letters/_/-) and one trailing space.
    while (true) {
      const m = /<\|channel\|>/i.exec(buf);
      if (!m) break;
      const idx = m.index;
      const startLen = m[0].length;
      const after = buf.slice(idx + startLen);
      const eat = this.computeChannelEat(after);
      if (eat === -1) {
        // Token complete, channel word incomplete. Drop token now, hold the word in tail.
        const emit = buf.slice(0, idx);
        const afterToken = buf.slice(idx + startLen);
        this.pendingChannelWord = true;
        this.tail = afterToken; // wait to consume the word on next feed
        removed += startLen;    // we know at least the token itself is dropped
        return { cleaned: emit, removed };
      }
      // Drop token + word
      buf = buf.slice(0, idx) + after.slice(eat);
      removed += startLen + eat;
    }

    // 4) Drop other single-token sentinels <|name|> (keep *_start/_end for later passes)
    buf = buf.replace(/<\|([A-Za-z0-9:_-]+)\|>/g, (full: string, name: string) => {
      if (/_start$/i.test(name) || /_end$/i.test(name)) return full;
      removed += full.length;
      return "";
    });

    // 5) Stream-safety: hold any trailing partial sentinel like "<", "<|", "<|name", "<|name|"
    const holdFrom = this.findHoldStart(buf);
    const cleaned = holdFrom === -1 ? buf : buf.slice(0, holdFrom);
    this.tail = holdFrom === -1 ? "" : buf.slice(holdFrom);

    return { cleaned, removed: removed + (before - (cleaned.length + this.tail.length)) };
  }

  flush(): string {
    let buf = this.tail;
    this.tail = "";

    // If we were waiting to eat the channel word, drop whatever is there (conservative).
    if (this.pendingChannelWord) {
      const eaten = this.consumeLeadingChannelWord(buf, /*allowPartial*/ true);
      buf = buf.slice(eaten);
      this.pendingChannelWord = false;
    }

    // Apply final transformations to tail
    buf = buf.replace(/<\|message\|>/gi, " ");
    buf = buf.replace(/<\|channel\|>\s*[A-Za-z_-]+\s*/gi, "");
    buf = buf.replace(/<\|[A-Za-z0-9:_-]+\|>/g, "");

    // Final clean of zero-width/control
    buf = buf
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    return buf;
  }

  // ---- helpers ----

  /** How many chars to eat after <|channel|> to remove the channel name. -1 → need more data. */
  private computeChannelEat(s: string): number {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    let j = i;
    while (j < s.length && /[A-Za-z_-]/.test(s[j])) j++;
    if (j === i) return -1;                   // no letters yet
    if (j === s.length) { this.pendingChannelWord = true; return -1; } // incomplete
    let k = j;
    if (s[k] === " ") k++;                    // optional trailing space
    return k;
  }

  /** Consume a leading channel word at the start of s. */
  private consumeLeadingChannelWord(s: string, allowPartial = false): number {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    let j = i;
    while (j < s.length && /[A-Za-z_-]/.test(s[j])) j++;
    if (j === i && !allowPartial) return 0;
    if (!allowPartial && j === s.length) return 0;
    if (j < s.length && s[j] === " ") j++;
    return j;
  }

  /** Index to hold from (start of a possible sentinel) or -1 if safe. */
  private findHoldStart(s: string): number {
    const lastLt = s.lastIndexOf("<");
    if (lastLt !== -1) {
      const tail = s.slice(lastLt);
      // e.g., "<", "<|", "<|name", "<|name|"
      if (/^<\|?[A-Za-z-]*\|?$/.test(tail)) return lastLt;
    }
    return -1;
  }
}

export default LLMNoiseFilterFirstPass;
