// src/utils/filter-passes/llm-adv-memory-scrub-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * AdvancedMemoryScrubPass: stream-safe, fence-aware.
 * - Drops memory/system/internal blocks when closed; otherwise holds from start.
 * - Preserves generic code fences (```lang ... ```).
 */
export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private tail = "";

  private readonly dropSpecs = [
    { start: /<\|memory_start\|>/i,        end: /<\|memory_end\|>/i },
    { start: /<memory>/i,                  end: /<\/memory>/i },
    { start: /<\|internal_start\|>/i,      end: /<\|internal_end\|>/i },
    { start: /<internal>/i,                end: /<\/internal>/i },
    { start: /<\|system_prompt_start\|>/i, end: /<\|system_prompt_end\|>/i },
    { start: /<system_prompt>/i,           end: /<\/system_prompt>/i },
    { start: /BEGIN\s+MEMORY\b/i,          end: /END\s+MEMORY\b/i },
    { start: /BEGIN\s+SYSTEM\s+PROMPT\b/i, end: /END\s+SYSTEM\s+PROMPT\b/i },
    { start: /BEGIN\s+INTERNAL\b/i,        end: /END\s+INTERNAL\b/i },
    { start: /BEGIN\s+SCRATCHPAD\b/i,      end: /END\s+SCRATCHPAD\b/i },
  ] as const;

  feed(chunk: string): PassFeedResult {
    const input = (this.tail ?? "") + (chunk ?? "");

    const holdFenceAt = this.findUnmatchedFenceStart(input);
    const pre = holdFenceAt === -1 ? input : input.slice(0, holdFenceAt);
    const post = holdFenceAt === -1 ? "" : input.slice(holdFenceAt);

    const segs = this.splitCompleteFences(pre);

    let cleaned = "";
    let holdFromAbs: number | null = null;

    for (const seg of segs) {
      if (seg.type === "fence") {
        cleaned += pre.slice(seg.start, seg.end);
        continue;
      }
      const res = this.processOutside(pre.slice(seg.start, seg.end));
      cleaned += res.processed;
      if (res.holdFrom >= 0) {
        holdFromAbs = seg.start + res.holdFrom;
        break;
      }
    }

    if (holdFromAbs !== null) {
      this.tail = pre.slice(holdFromAbs) + post;
      return { cleaned, removed: input.length - (cleaned.length + this.tail.length) };
    }

    // Hold partial sentinel tail for memory/internal/system_prompt prefixes
    const partialFrom = this.findPartialSentinelStart(cleaned, /^<\|?(?:memory|internal|system_prompt)/i);
    if (partialFrom !== -1) {
      this.tail = cleaned.slice(partialFrom) + post;
      return { cleaned: cleaned.slice(0, partialFrom), removed: input.length - (cleaned.slice(0, partialFrom).length + this.tail.length) };
    }

    this.tail = post;
    return { cleaned, removed: input.length - (cleaned.length + this.tail.length) };
  }

  flush(): string {
    const out = this.tail;
    this.tail = "";
    return out;
  }

  // ---- outside-fence block processing ----

  private processOutside(s: string): { processed: string; holdFrom: number } {
    let work = s;

    // Resolve closed blocks
    for (const spec of this.dropSpecs) {
      work = this.resolveClosedBlocks(work, spec.start, spec.end);
    }

    // Unmatched start -> hold
    let holdFrom = -1;
    for (const spec of this.dropSpecs) {
      const i = this.indexOfRegex(work, spec.start, 0);
      if (i !== -1 && this.indexOfRegex(work, spec.end, i + 1) === -1) {
        holdFrom = holdFrom === -1 ? i : Math.min(holdFrom, i);
      }
    }
    if (holdFrom !== -1) return { processed: work.slice(0, holdFrom), holdFrom };

    return { processed: work, holdFrom: -1 };
  }

  private resolveClosedBlocks(s: string, start: RegExp, end: RegExp): string {
    let from = 0;
    while (true) {
      const i = this.indexOfRegex(s, start, from);
      if (i === -1) break;
      const j = this.indexOfRegex(s, end, i + 1);
      if (j === -1) break;
      const endLen = s.slice(j).match(end)?.[0].length ?? 0;
      s = s.slice(0, i) + s.slice(j + endLen); // drop
      from = i;
    }
    return s;
  }

  // ---- fences & helpers ----

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

  private findPartialSentinelStart(s: string, prefix: RegExp): number {
    const lastLt = s.lastIndexOf("<");
    if (lastLt === -1) return -1;
    const tail = s.slice(lastLt);
    if (/^<\|?[A-Za-z0-9:_-]*\|?$/.test(tail) && prefix.test(tail)) return lastLt;
    return -1;
  }

  private indexOfRegex(s: string, re: RegExp, from: number): number {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    r.lastIndex = from;
    const m = r.exec(s);
    return m ? m.index : -1;
  }
}

export default AdvancedMemoryScrubPass;
