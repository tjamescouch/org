// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * First pass: Buffered, stream-safe, fence-aware cleanup.
 *
 * - Preserves content inside generic code fences: ```lang\n ... \n```
 * - <|channel|><word>  → remove token + word (word may straddle chunks)
 * - <|message|>        → single space
 * - Other <|token|>    → removed (except *_start/*_end), OUTSIDE fences only
 * - Removes zero-width and control chars (except \t \r \n)
 */
export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private buf = "";

  feed(chunk: string): PassFeedResult {
    const before = (chunk ?? "").length;
    this.buf += chunk ?? "";

    // Strip zero-width & control (safe globally)
    this.buf = this.buf
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    // Process the whole buffer but protect COMPLETE generic fences while transforming.
    const { masked, fences } = this.maskCompleteFences(this.buf);
    let work = masked;

    // <|message|>  -> space (outside fences)
    work = work.replace(/<\|message\|>/gi, " ");

    // <|channel|> + word   (letters/_/-) with optional spaces around
    //   - Only remove if the WORD is complete; otherwise leave and the stream
    //     will hold from the start tag (detected below).
    work = work.replace(
      /<\|channel\|>\s*[A-Za-z_-]+\s*/gi,
      ""
    );

    // Remove other single-token sentinels, keep *_start/*_end for later passes.
    work = work.replace(/<\|([A-Za-z0-9:_-]+)\|>/g, (full: string, name: string) => {
      return (/_start$/i.test(name) || /_end$/i.test(name)) ? full : "";
    });

    // Restore masked fences back to make hold calculations accurate.
    this.buf = this.unmask(fences, work);

    // ---- determine safe emit point ----
    const holdAt: number | null = this.earliestHoldIndexFirstPass(this.buf);
    let cleaned: string;
    if (holdAt === null) {
      cleaned = this.buf;
      this.buf = "";
    } else {
      cleaned = this.buf.slice(0, holdAt);
      this.buf = this.buf.slice(holdAt);
    }

    const removed = Math.max(0, before - cleaned.length);
    return { cleaned, removed };
  }

  flush(): string {
    // At flush we can safely finalize: any leftover channel word after <|channel|> is removed.
    // Do one more transform pass without masking (whatever remains is final).
    this.buf = this.buf.replace(
      /<\|channel\|>\s*[A-Za-z_-]*\s*/gi,
      ""
    ).replace(/<\|message\|>/gi, " ");
    // Do NOT touch generic code fences on flush (content should remain intact).
    const out = this.buf;
    this.buf = "";
    return out;
  }

  // ---------- hold logic for first pass ----------

  private earliestHoldIndexFirstPass(s: string): number | null {
    // 1) If a generic fence is open, hold from that start
    const fenceStart = this.findUnmatchedFenceStart(s);
    let holdAt: number | null = fenceStart !== -1 ? fenceStart : null;

    // 2) If there is a <|channel|> with an INCOMPLETE word after it, hold from <|channel|>
    const chIdx = this.lastIndexOfCI(s, "<|channel|>");
    if (chIdx !== -1) {
      const after = s.slice(chIdx + "<|channel|>".length);
      // Scan for a possibly incomplete word
      let i = 0;
      while (i < after.length && /\s/.test(after[i])) i++;
      let j = i;
      while (j < after.length && /[A-Za-z_-]/.test(after[j])) j++;
      const wordLen = j - i;
      const completed = wordLen > 0 && (j < after.length ? (after[j] === " " || !/[A-Za-z_-]/.test(after[j])) : false);
      if (!completed) holdAt = (holdAt === null ? chIdx : Math.min(holdAt, chIdx));
    }

    // 3) Trailing partial singleton sentinel (e.g., "<", "<|", "<|name", "<|name|")
    const partialStart = this.indexOfTrailingPartialSingleton(s);
    if (partialStart !== -1) holdAt = (holdAt === null ? partialStart : Math.min(holdAt, partialStart));

    return holdAt;
  }

  private indexOfTrailingPartialSingleton(s: string): number {
    const i = s.lastIndexOf("<");
    if (i === -1) return -1;
    const tail = s.slice(i);
    // Very conservative: looks like start of a <...> or <|...|> but not closed yet.
    return /^<[^>]*$/.test(tail) ? i : -1;
  }

  // ---------- generic fences (```lang\n ... \n```) ----------

  private maskCompleteFences(s: string): { masked: string; fences: string[] } {
    let out = "";
    let pos = 0;
    const fences: string[] = [];
    while (true) {
      const i = s.indexOf("```", pos);
      if (i === -1) break;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) break;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) break;
      // [i, j+3)
      const idx = fences.length;
      fences.push(s.slice(i, j + 3));
      out += s.slice(pos, i) + this.placeholder(idx);
      pos = j + 3;
    }
    out += s.slice(pos);
    return { masked: out, fences };
  }

  private unmask(fences: string[], s: string): string {
    return s.replace(/\u0000F(\d+)\u0000/g, (_m, g1: string) => {
      const k = Number(g1);
      return Number.isFinite(k) && fences[k] !== undefined ? fences[k] : _m;
    });
  }

  private placeholder(i: number): string { return `\u0000F${i}\u0000`; }

  private findUnmatchedFenceStart(s: string): number {
    let pos = 0;
    while (true) {
      const i = s.indexOf("```", pos);
      if (i === -1) return -1;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) return i;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) return i;
      pos = j + 3;
    }
  }

  private lastIndexOfCI(s: string, token: string): number {
    return s.toLowerCase().lastIndexOf(token.toLowerCase());
  }
}

export default LLMNoiseFilterFirstPass;
