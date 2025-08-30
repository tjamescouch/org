// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * First pass: buffered, stream-safe, and fence-aware.
 *
 * - Preserves complete generic code fences (```lang\n ... \n```); never edits inside.
 * - <|channel|><word>  -> removes the token and the following word (letters/_/-) plus one optional space.
 * - <|message|>        -> single space.
 * - Other <|token|>    -> removed (except *_start/*_end and {channel,message}) outside fences only.
 * - Strips zero-width & control chars (except \t \r \n).
 */
export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private buffer = "";

  feed(chunk: string): PassFeedResult {
    const incoming = chunk ?? "";
    this.buffer += incoming;

    // Global safe cleanup
    this.buffer = this.buffer
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    // Determine SAFE EMIT boundary first (so we don't transform across open structures)
    const holdAt = this.computeHoldIndex(this.buffer);
    const safeEnd = holdAt ?? this.buffer.length;

    // Transform only the safe prefix, preserving fences
    const safePrefix = this.buffer.slice(0, safeEnd);
    const cleanedPrefix = this.transformOutsideFences(safePrefix);

    // Keep the rest for the next feed
    this.buffer = this.buffer.slice(safeEnd);

    return {
      cleaned: cleanedPrefix,
      removed: incoming.length - cleanedPrefix.length < 0 ? 0 : incoming.length - cleanedPrefix.length,
    };
  }

  flush(): string {
    // At flush, the remainder is considered complete; still preserve fences.
    const out = this.transformOutsideFences(this.buffer);
    this.buffer = "";
    return out;
  }

  // ---------------- core helpers ----------------

  /** Transform text, but *never* modify complete generic code fences. */
  private transformOutsideFences(s: string): string {
    const segs = this.splitCompleteFences(s);
    let out = "";

    for (const seg of segs) {
      if (seg.type === "fence") {
        out += s.slice(seg.start, seg.end); // keep verbatim
        continue;
      }
      let txt = s.slice(seg.start, seg.end);

      // 1) <|message|> -> space
      txt = txt.replace(/<\|message\|>/gi, " ");

      // 2) <|channel|> + word (letters/_/-) with optional surrounding spaces
      //    Only remove when the word is present in the processed span.
      txt = txt.replace(/<\|channel\|>\s*[A-Za-z_-]+\s*/gi, "");

      // 3) Other singletons (skip *_start/*_end and {channel,message})
      txt = txt.replace(/<\|([A-Za-z0-9:_-]+)\|>/g, (full: string, name: string) => {
        if (/_start$/i.test(name) || /_end$/i.test(name)) return full;
        if (/^(channel|message)$/i.test(name)) return full;
        return "";
      });

      out += txt;
    }
    return out;
  }

  /**
   * Compute earliest index we must HOLD from (don't emit/transform beyond):
   *  - start of an unmatched generic fence ```lang\n ... (no closing yet)
   *  - a <|channel|> whose following word is incomplete at buffer end
   *  - a trailing partial tag like "<", "<|", "<|name", "<tag" (outside fences)
   */
  private computeHoldIndex(s: string): number | null {
    let hold: number | null = null;

    // A) Unmatched generic fence start
    const fenceStart = this.findUnmatchedFenceStart(s);
    if (fenceStart !== -1) hold = fenceStart;

    // Build fence segments to avoid reacting to stuff *inside* complete fences
    const fences = this.splitCompleteFences(s).filter((x) => x.type === "fence");

    const isInsideFence = (idx: number) =>
      fences.some((f) => idx >= f.start && idx < f.end);

    // B) Incomplete <|channel|>word at the tail (outside fences)
    const chTok = "<|channel|>";
    let searchFrom = 0;
    while (true) {
      const i = s.toLowerCase().indexOf(chTok, searchFrom);
      if (i === -1) break;
      searchFrom = i + 1;
      if (isInsideFence(i)) continue;

      // Parse the would-be word after the token
      let j = i + chTok.length;
      while (j < s.length && /\s/.test(s[j])) j++;
      let k = j;
      while (k < s.length && /[A-Za-z_-]/.test(s[k])) k++;

      const hasWord = k > j;
      const complete = hasWord && (k < s.length ? true : false); // complete only if we didn't run out of buffer
      if (!complete) {
        hold = hold === null ? i : Math.min(hold, i);
        break;
      }
      // optional trailing space doesn't affect completeness
    }

    // C) Trailing partial tag (outside fences)
    const lastLt = s.lastIndexOf("<");
    if (lastLt !== -1 && !isInsideFence(lastLt)) {
      const tail = s.slice(lastLt);
      if (/^<[^>]*$/.test(tail)) {
        hold = hold === null ? lastLt : Math.min(hold, lastLt);
      }
    }

    return hold;
  }

  // ---------------- fence machinery ----------------

  /** Split into alternating TEXT and complete FENCE segments with absolute offsets. */
  private splitCompleteFences(
    s: string
  ): Array<{ type: "text" | "fence"; start: number; end: number }> {
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

  /** Find earliest unmatched generic fence start ```lang\n with no closing ``` yet; -1 if none. */
  private findUnmatchedFenceStart(s: string): number {
    let from = 0;
    while (true) {
      const i = s.indexOf("```", from);
      if (i === -1) return -1;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) return i;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) return i;
      from = j + 3; // skip closed fence and continue
    }
  }
}

export default LLMNoiseFilterFirstPass;
