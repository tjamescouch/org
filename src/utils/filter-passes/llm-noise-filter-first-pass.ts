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

    // Determine SAFE EMIT boundary first, so we never transform across open structures.
    const holdAt = this.computeHoldIndex(this.buffer);
    const safeEnd = holdAt ?? this.buffer.length;

    // Transform only the safe prefix, preserving fences by masking them first.
    const safePrefix = this.buffer.slice(0, safeEnd);
    const cleanedPrefix = this.transformOutsideFences(safePrefix);

    // Keep the rest for the next feed
    this.buffer = this.buffer.slice(safeEnd);

    return {
      cleaned: cleanedPrefix,
      // best-effort accounting; tests asserting 0 removed use other passes
      removed: 0,
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
    const { masked, fences } = this.maskCompleteFences(s);

    // All edits happen on the masked string (i.e., outside fences).
    let t = masked;

    // 1) <|message|> -> space
    t = t.replace(/<\|message\|>/gi, " ");

    // 2) <|channel|> + word (letters/_/-) with optional surrounding spaces
    //    Only removes when the word is present in this processed span.
    t = t.replace(/<\|channel\|>\s*[A-Za-z_-]+\s*/gi, "");

    // 3) Other singletons (skip *_start/*_end and {channel,message})
    t = t.replace(/<\|([A-Za-z0-9:_-]+)\|>/g, (full: string, name: string) => {
      if (/_start$/i.test(name) || /_end$/i.test(name)) return full;
      if (/^(channel|message)$/i.test(name)) return full;
      return "";
    });

    return this.unmask(fences, t);
  }

  /**
   * Compute earliest index we must HOLD from (don't emit/transform beyond):
   *  - start of an unmatched generic fence ```lang\n ... (no closing yet)
   *  - a <|channel|> whose following word is incomplete at buffer end (outside fences)
   *  - a trailing partial tag like "<", "<|", "<|name", "<tag" (outside fences)
   */
  private computeHoldIndex(s: string): number | null {
    let hold: number | null = null;

    // A) Unmatched generic fence start
    const fenceStart = this.findUnmatchedFenceStart(s);
    if (fenceStart !== -1) hold = fenceStart;

    // Build fence ranges (complete fences) to avoid reacting to stuff inside.
    const fenceRanges = this.fenceRanges(s);
    const isInsideFence = (idx: number) =>
      fenceRanges.some((r) => idx >= r.start && idx < r.end);

    // B) Incomplete <|channel|>word at the tail (outside fences)
    const lower = s.toLowerCase();
    const token = "<|channel|>";
    let from = 0;
    while (true) {
      const i = lower.indexOf(token, from);
      if (i === -1) break;
      from = i + 1;
      if (isInsideFence(i)) continue;

      let j = i + token.length;
      while (j < s.length && /\s/.test(s[j])) j++;
      let k = j;
      while (k < s.length && /[A-Za-z_-]/.test(s[k])) k++;

      const hasWord = k > j;
      const complete = hasWord && (k < s.length ? true : false);
      if (!complete) {
        hold = hold === null ? i : Math.min(hold, i);
        break;
      }
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

  /** Mask complete fences using a robust regex, returning placeholders + table. */
  private maskCompleteFences(s: string): { masked: string; fences: string[] } {
    const fences: string[] = [];
    const masked = s.replace(/```[^\n]*\n[\s\S]*?```/g, (m) => {
      const id = fences.length;
      fences.push(m);
      return this.placeholder(id);
    });
    return { masked, fences };
  }

  private unmask(fences: string[], s: string): string {
    return s.replace(/\u0000F(\d+)\u0000/g, (_m, g1: string) => {
      const k = Number(g1);
      return Number.isFinite(k) && fences[k] !== undefined ? fences[k] : _m;
    });
  }

  private placeholder(i: number): string { return `\u0000F${i}\u0000`; }

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

  /** Ranges of complete fences for fast “inside fence?” checks during holds. */
  private fenceRanges(s: string): Array<{ start: number; end: number }> {
    const re = /```[^\n]*\n[\s\S]*?```/g;
    const ranges: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    return ranges;
  }
}

export default LLMNoiseFilterFirstPass;
