// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * First pass: stream-safe + fence-aware cleanup.
 * - Preserves content inside generic code fences (```lang\n...\n```).
 * - <|channel|><word> (e.g., "final") is removed; word may straddle chunks.
 * - <|message|> becomes a single space.
 * - Other <|token|> singletons are removed (except *_start/*_end) outside fences.
 * - Strips zero-width & control chars (except \t \r \n).
 */
export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";
  private pendingChannelWord = false; // last chunk ended just after <|channel|>

  feed(chunk: string): PassFeedResult {
    const input = (this.tail ?? "") + (chunk ?? "");

    // If waiting to consume the channel word, try now.
    if (this.pendingChannelWord) {
      const eaten = this.consumeChannelWord(input, /*allowPartial*/ false);
      if (eaten === 0) {
        this.tail = input; // still incomplete
        return { cleaned: "", removed: 0 };
      }
      // Drop the word and continue with the rest in one go.
      return this.process(input.slice(eaten));
    }

    return this.process(input);
  }

  flush(): string {
    // Finalize the remaining buffer, allowing partial channel word consumption.
    const out = this.process(this.tail, /*isFlush*/ true);
    this.tail = "";
    this.pendingChannelWord = false;
    return out.cleaned;
  }

  // ---------- core ----------

  private process(bufIn: string, isFlush = false): PassFeedResult {
    let buf = bufIn ?? "";

    // Strip zero-width & control chars (except \t \r \n).
    buf = buf
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    // If a generic fence start exists without a closing fence, HOLD from there.
    const holdFenceAt = this.findUnmatchedFenceStart(buf);
    const pre = holdFenceAt === -1 ? buf : buf.slice(0, holdFenceAt);
    const post = holdFenceAt === -1 ? "" : buf.slice(holdFenceAt);

    // Split `pre` into [text,fence,text,fence,...] with absolute offsets.
    const segs = this.splitCompleteFences(pre);

    let cleaned = "";
    let heldFromAbs: number | null = null;

    for (const seg of segs) {
      if (seg.type === "fence") {
        cleaned += pre.slice(seg.start, seg.end); // keep fence verbatim
        continue;
      }

      const text = pre.slice(seg.start, seg.end);
      const res = this.processOutsideText(text);
      cleaned += res.processed;

      if (res.holdFrom >= 0) {
        // Need to buffer from this absolute position onward (channel word incomplete).
        heldFromAbs = seg.start + res.holdFrom;
        break;
      }
    }

    if (heldFromAbs !== null) {
      // Buffer from heldFromAbs in `pre`, plus all of `post`.
      this.tail = pre.slice(heldFromAbs) + post;
      this.pendingChannelWord = true;
      return { cleaned, removed: bufIn.length - (cleaned.length + this.tail.length) };
    }

    // After normal processing, if the very end looks like a partial sentinel, HOLD it too.
    const partialFrom = this.findPartialSentinelStart(cleaned);
    if (partialFrom !== -1) {
      this.tail = cleaned.slice(partialFrom) + post;
      cleaned = cleaned.slice(0, partialFrom);
      return { cleaned, removed: bufIn.length - (cleaned.length + this.tail.length) };
    }

    // If flushing and we were waiting on a channel word, consume what remains.
    if (isFlush && this.pendingChannelWord) {
      const eaten = this.consumeChannelWord(post, /*allowPartial*/ true);
      this.tail = post.slice(eaten);
      this.pendingChannelWord = false;
      return { cleaned: cleaned + this.tail, removed: 0 }; // tail is plain text now
    }

    // Normal case.
    this.tail = post;
    return { cleaned, removed: bufIn.length - (cleaned.length + this.tail.length) };
  }

  /**
   * Process a "non-fence" span:
   *  - <|message|> -> " "
   *  - <|channel|>word -> drop token+word (word may span chunks; if incomplete => hold)
   *  - drop other <|name|> singletons (except *_start/*_end)
   */
  private processOutsideText(s: string): { processed: string; holdFrom: number } {
    let i = 0;
    let out = "";

    while (i < s.length) {
      // 1) <|message|>
      if (this.ciStartsWith(s, i, "<|message|>")) {
        out += " ";
        i += "<|message|>".length;
        continue;
      }

      // 2) <|channel|> + word
      if (this.ciStartsWith(s, i, "<|channel|>")) {
        const startLen = "<|channel|>".length;
        const after = s.slice(i + startLen);
        const eat = this.computeChannelEat(after);
        if (eat === -1) {
          // Need to hold from here (word incomplete).
          return { processed: out, holdFrom: i };
        }
        // Drop token + word
        i += startLen + eat;
        continue;
      }

      // 3) other singletons <|name|> (drop unless *_start/*_end)
      const m = /^<\|([A-Za-z0-9:_-]+)\|>/.exec(s.slice(i));
      if (m) {
        const name = m[1];
        const len = m[0].length;
        if (/_start$/i.test(name) || /_end$/i.test(name)) {
          out += m[0]; // keep for later passes
        }
        // else drop
        i += len;
        continue;
      }

      // Default: copy char
      out += s[i];
      i++;
    }

    return { processed: out, holdFrom: -1 };
  }

  // ---------- helpers ----------

  /** Case-insensitive s.startsWith(token, i). */
  private ciStartsWith(s: string, i: number, token: string): boolean {
    return s.length - i >= token.length &&
      s.slice(i, i + token.length).toLowerCase() === token.toLowerCase();
  }

  /** For `<|channel|>`: eat optional spaces + [A-Za-z_-]+ + optional single space. -1 if incomplete. */
  private computeChannelEat(s: string): number {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    let j = i;
    while (j < s.length && /[A-Za-z_-]/.test(s[j])) j++;
    if (j === i) return -1;        // no word yet
    if (j === s.length) return -1; // incomplete
    let k = j;
    if (s[k] === " ") k++;         // optional trailing space
    return k;
  }

  /** Consume a channel word at the very start of s; returns chars eaten. */
  private consumeChannelWord(s: string, allowPartial: boolean): number {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    let j = i;
    while (j < s.length && /[A-Za-z_-]/.test(s[j])) j++;
    if (j === i) return allowPartial ? i : 0;
    if (!allowPartial && j === s.length) return 0;
    if (j < s.length && s[j] === " ") j++;
    return j;
  }

  /** Return index of first unmatched generic fence start ```... ; -1 if none. */
  private findUnmatchedFenceStart(s: string): number {
    let pos = 0;
    while (true) {
      const i = s.indexOf("```", pos);
      if (i === -1) return -1;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) return i;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) return i;
      pos = j + 3; // skip closed fence and continue
    }
  }

  /** Split into alternating text/fence segments with absolute offsets. */
  private splitCompleteFences(s: string): Array<{ type: "text" | "fence"; start: number; end: number }> {
    const segs: Array<{ type: "text" | "fence"; start: number; end: number }> = [];
    let pos = 0;
    while (true) {
      const i = s.indexOf("```", pos);
      if (i === -1) break;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) break;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) break;
      if (i > pos) segs.push({ type: "text", start: pos, end: i });
      segs.push({ type: "fence", start: i, end: j + 3 });
      pos = j + 3;
    }
    if (pos < s.length) segs.push({ type: "text", start: pos, end: s.length });
    return segs;
    }

  /** If the end looks like a partial `<|...` sentinel, return index to hold from; else -1. */
  private findPartialSentinelStart(s: string): number {
    const lastLt = s.lastIndexOf("<");
    if (lastLt === -1) return -1;
    const tail = s.slice(lastLt);
    return /^<\|?[A-Za-z0-9:_-]*\|?$/.test(tail) ? lastLt : -1;
  }
}

export default LLMNoiseFilterFirstPass;
