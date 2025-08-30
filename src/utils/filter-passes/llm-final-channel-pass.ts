// src/utils/filter-passes/llm-final-channel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * FinalChannelPass
 *
 * Goal: prevent leaking non-final channels (analysis/system/tools) and prefer
 * emitting "final" channel content if explicitly marked.
 *
 * Behaviors:
 *  - DROP CONTENT for known analysis/scratchpad channels:
 *      <|analysis_start|> ... <|analysis_end|>
 *      <analysis> ... </analysis>
 *      ```analysis ... ```
 *      ```chain_of_thought / thoughts / scratchpad ... ```
 *
 *  - UNWRAP "final" channel markers:
 *      <|final_start|> ... <|final_end|>
 *      <final> ... </final>
 *      ```final ... ```
 *
 * Stream-safe: buffers incomplete starts without ends.
 */
export class FinalChannelPass implements LLMNoiseFilterPass {
  private tail = "";

  private readonly dropBlocks: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
    { start: /<\|analysis_start\|>/i,                end: /<\|analysis_end\|>/i },
    { start: /<analysis>/i,                          end: /<\/analysis>/i },
    { start: /<\|scratchpad_start\|>/i,              end: /<\|scratchpad_end\|>/i },
    { start: /<scratchpad>/i,                        end: /<\/scratchpad>/i },
  ];

  private readonly unwrapBlocks: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
    { start: /<\|final_start\|>/i,                   end: /<\|final_end\|>/i },
    { start: /<final>/i,                             end: /<\/final>/i },
  ];

  private readonly fencedDropStart = /```(?:analysis|chain[_-]?of[_-]?thought|thoughts?|scratchpad)[^\n]*\n/i;
  private readonly fencedFinalStart = /```final[^\n]*\n/i;
  private readonly fencedEnd = /```/i;

  feed(chunk: string): PassFeedResult {
    const incoming = (chunk ?? "");
    let buf = this.tail + incoming;
    const beforeLen = buf.length;

    // 1) Remove fenced analysis/scratchpad blocks
    buf = this.removeAllFencedBlocks(buf, this.fencedDropStart, "drop");

    // 2) Unwrap fenced final blocks
    buf = this.removeAllFencedBlocks(buf, this.fencedFinalStart, "unwrap");

    // 3) Drop structured analysis-like blocks
    for (const spec of this.dropBlocks) {
      buf = this.processBlock(buf, spec.start, spec.end, "drop");
    }

    // 4) Unwrap structured final blocks
    for (const spec of this.unwrapBlocks) {
      buf = this.processBlock(buf, spec.start, spec.end, "unwrap");
    }

    // Safe emit point: if any unmatched start remains, hold from earliest
    const holdFrom = this.findEarliestUnmatchedStart(buf);
    const emitUpto = holdFrom ?? buf.length;

    const cleaned = buf.slice(0, emitUpto);
    this.tail = buf.slice(emitUpto);
    const removed = beforeLen - (cleaned.length + this.tail.length);
    return { cleaned, removed: removed > 0 ? removed : 0 };
  }

  flush(): string {
    let buf = this.tail;
    this.tail = "";

    // If a fenced drop block start remains without end, drop it entirely
    const dropIdx = this.indexOfRegex(buf, this.fencedDropStart, 0);
    if (dropIdx !== -1) {
      buf = buf.slice(0, dropIdx);
    }
    // If a fenced final block start remains without end, unwrap by dropping the start fence
    const finalIdx = this.indexOfRegex(buf, this.fencedFinalStart, 0);
    if (finalIdx !== -1) {
      const m = buf.slice(finalIdx).match(this.fencedFinalStart);
      const len = m?.[0]?.length ?? 0;
      buf = buf.slice(0, finalIdx) + buf.slice(finalIdx + len);
    }

    // Structured blocks on flush
    for (const spec of this.dropBlocks) {
      const idxStart = this.indexOfRegex(buf, spec.start, 0);
      if (idxStart !== -1) {
        // drop from start
        buf = buf.slice(0, idxStart);
      }
    }
    for (const spec of this.unwrapBlocks) {
      let idxStart = this.indexOfRegex(buf, spec.start, 0);
      while (idxStart !== -1) {
        const m = buf.slice(idxStart).match(spec.start);
        const len = m?.[0]?.length ?? 0;
        buf = buf.slice(0, idxStart) + buf.slice(idxStart + len);
        idxStart = this.indexOfRegex(buf, spec.start, idxStart);
      }
    }

    return buf;
  }

  // ---- helpers ----

  private processBlock(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let searchFrom = 0;
    while (true) {
      const idxStart = this.indexOfRegex(s, start, searchFrom);
      if (idxStart === -1) break;
      const idxEnd = this.indexOfRegex(s, end, idxStart + 1);
      if (idxEnd === -1) {
        // streaming: hold unmatched start
        break;
      }
      const startLen = s.slice(idxStart).match(start)?.[0]?.length ?? 0;
      const endLen = s.slice(idxEnd).match(end)?.[0]?.length ?? 0;
      if (mode === "drop") {
        s = s.slice(0, idxStart) + s.slice(idxEnd + endLen);
        searchFrom = idxStart;
      } else {
        const inner = s.slice(idxStart + startLen, idxEnd);
        s = s.slice(0, idxStart) + inner + s.slice(idxEnd + endLen);
        searchFrom = idxStart + inner.length;
      }
    }
    return s;
  }

  private removeAllFencedBlocks(s: string, start: RegExp, mode: "drop" | "unwrap"): string {
    let searchFrom = 0;
    while (true) {
      const idxStart = this.indexOfRegex(s, start, searchFrom);
      if (idxStart === -1) break;
      const sm = s.slice(idxStart).match(start);
      const sLen = sm?.[0]?.length ?? 0;

      const idxEnd = this.indexOfRegex(s, this.fencedEnd, idxStart + sLen);
      if (idxEnd === -1) {
        // hold unmatched
        break;
      }
      const eLen = s.slice(idxEnd).match(this.fencedEnd)?.[0]?.length ?? 0;

      if (mode === "drop") {
        s = s.slice(0, idxStart) + s.slice(idxEnd + eLen);
        searchFrom = idxStart;
      } else {
        const inner = s.slice(idxStart + sLen, idxEnd);
        s = s.slice(0, idxStart) + inner + s.slice(idxEnd + eLen);
        searchFrom = idxStart + inner.length;
      }
    }
    return s;
  }

  private findEarliestUnmatchedStart(s: string): number | null {
    let h: number | null = null;

    for (const spec of this.dropBlocks) {
      const i = this.indexOfRegex(s, spec.start, 0);
      if (i !== -1 && this.indexOfRegex(s, spec.end, i + 1) === -1) {
        h = h === null ? i : Math.min(h, i);
      }
    }
    for (const spec of this.unwrapBlocks) {
      const i = this.indexOfRegex(s, spec.start, 0);
      if (i !== -1 && this.indexOfRegex(s, spec.end, i + 1) === -1) {
        h = h === null ? i : Math.min(h, i);
      }
    }

    const fDrop = this.indexOfRegex(s, this.fencedDropStart, 0);
    if (fDrop !== -1 && this.indexOfRegex(s, this.fencedEnd, fDrop + 1) === -1) {
      h = h === null ? fDrop : Math.min(h, fDrop);
    }
    const fFin = this.indexOfRegex(s, this.fencedFinalStart, 0);
    if (fFin !== -1 && this.indexOfRegex(s, this.fencedEnd, fFin + 1) === -1) {
      h = h === null ? fFin : Math.min(h, fFin);
    }

    return h;
  }

  private indexOfRegex(s: string, re: RegExp, from: number): number {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    r.lastIndex = from;
    const m = r.exec(s);
    return m ? m.index : -1;
  }
}

export default FinalChannelPass;
