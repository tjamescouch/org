// src/utils/filter-passes/llm-final-channel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * FinalChannelPass (conservative, stream-safe).
 *
 * - Drops analysis/scratchpad content blocks.
 * - Unwraps explicit "final" blocks.
 * - Otherwise leaves text alone.
 */
export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    let buf = (this.tail ?? "") + (chunk ?? "");
    const before = buf.length;

    // Fenced analysis-like blocks (drop)
    buf = this.processFenced(buf, /```(?:analysis|chain[_-]?of[_-]?thought|thoughts?|scratchpad)[^\n]*\n/i, /```/i, "drop");
    // Fenced final (unwrap)
    buf = this.processFenced(buf, /```final[^\n]*\n/i, /```/i, "unwrap");

    // Structured blocks
    buf = this.processBlocks(buf, /<\|analysis_start\|>/i, /<\|analysis_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<analysis>/i, /<\/analysis>/i, "drop");
    buf = this.processBlocks(buf, /<\|scratchpad_start\|>/i, /<\|scratchpad_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<scratchpad>/i, /<\/scratchpad>/i, "drop");

    buf = this.processBlocks(buf, /<\|final_start\|>/i, /<\|final_end\|>/i, "unwrap");
    buf = this.processBlocks(buf, /<final>/i, /<\/final>/i, "unwrap");

    // Hold only if the tail looks like a partial start for the patterns above
    const holdFrom = this.findHoldStart(buf);
    const cleaned = holdFrom === -1 ? buf : buf.slice(0, holdFrom);
    this.tail = holdFrom === -1 ? "" : buf.slice(holdFrom);

    const removed = before - (cleaned.length + this.tail.length);
    return { cleaned, removed: removed > 0 ? removed : 0 };
  }

  flush(): string {
    let buf = this.tail;
    this.tail = "";

    // Drop any still-open drop blocks from start; unwrap final starts.
    const dropSpecs: Array<{ s: RegExp; e: RegExp }> = [
      { s: /<\|analysis_start\|>/i,   e: /<\|analysis_end\|>/i },
      { s: /<analysis>/i,             e: /<\/analysis>/i },
      { s: /<\|scratchpad_start\|>/i, e: /<\|scratchpad_end\|>/i },
      { s: /<scratchpad>/i,           e: /<\/scratchpad>/i },
    ];
    for (const spec of dropSpecs) {
      const i = this.findIndexOf(buf, spec.s, 0);
      if (i !== -1 && this.findIndexOf(buf, spec.e, i + 1) === -1) {
        buf = buf.slice(0, i);
      }
    }

    const unwrapSpecs: Array<{ s: RegExp }> = [
      { s: /<\|final_start\|>/i },
      { s: /<final>/i },
    ];
    for (const spec of unwrapSpecs) {
      let i = this.findIndexOf(buf, spec.s, 0);
      while (i !== -1) {
        const m = buf.slice(i).match(spec.s);
        const len = m?.[0]?.length ?? 0;
        buf = buf.slice(0, i) + buf.slice(i + len);
        i = this.findIndexOf(buf, spec.s, i);
      }
    }

    // Fenced: If a fenced analysis start remains with no closing, drop from start.
    const iDropFence = this.findIndexOf(buf, /```(?:analysis|chain[_-]?of[_-]?thought|thoughts?|scratchpad)[^\n]*\n/i, 0);
    if (iDropFence !== -1) buf = buf.slice(0, iDropFence);

    // Fenced final: remove the opening fence if no close
    const iFinalFence = this.findIndexOf(buf, /```final[^\n]*\n/i, 0);
    if (iFinalFence !== -1) {
      const m = buf.slice(iFinalFence).match(/```final[^\n]*\n/i);
      const len = m?.[0]?.length ?? 0;
      buf = buf.slice(0, iFinalFence) + buf.slice(iFinalFence + len);
    }

    return buf;
  }

  // ---- helpers ----

  private processBlocks(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let from = 0;
    while (true) {
      const i = this.findIndexOf(s, start, from);
      if (i === -1) break;
      const j = this.findIndexOf(s, end, i + 1);
      if (j === -1) break;
      const startLen = (s.slice(i).match(start)?.[0]?.length) ?? 0;
      const endLen = (s.slice(j).match(end)?.[0]?.length) ?? 0;
      if (mode === "drop") {
        s = s.slice(0, i) + s.slice(j + endLen);
        from = i;
      } else {
        const inner = s.slice(i + startLen, j);
        s = s.slice(0, i) + inner + s.slice(j + endLen);
        from = i + inner.length;
      }
    }
    return s;
  }

  private processFenced(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let from = 0;
    while (true) {
      const i = this.findIndexOf(s, start, from);
      if (i === -1) break;
      const startLen = (s.slice(i).match(start)?.[0]?.length) ?? 0;
      const j = this.findIndexOf(s, end, i + startLen);
      if (j === -1) break;
      const endLen = (s.slice(j).match(end)?.[0]?.length) ?? 0;
      if (mode === "drop") {
        s = s.slice(0, i) + s.slice(j + endLen);
        from = i;
      } else {
        const inner = s.slice(i + startLen, j);
        s = s.slice(0, i) + inner + s.slice(j + endLen);
        from = i + inner.length;
      }
    }
    return s;
  }

  private findHoldStart(s: string): number {
    const lastLt = s.lastIndexOf("<");
    if (lastLt !== -1) {
      const tail = s.slice(lastLt);
      if (/^<\|?(?:analysis|scratchpad|final)/i.test(tail) && !/[>]/.test(tail)) return lastLt;
    }
    const lastTicks = s.lastIndexOf("```");
    if (lastTicks !== -1) {
      const tail = s.slice(lastTicks);
      if (/^```(?:analysis|chain[_-]?of[_-]?thought|thoughts?|scratchpad|final)/i.test(tail) &&
          !/```/.test(tail.slice(3))) return lastTicks;
    }
    return -1;
  }

  private findIndexOf(s: string, re: RegExp, from: number): number {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    r.lastIndex = from;
    const m = r.exec(s);
    return m ? m.index : -1;
  }
}

export default FinalChannelPass;
