// src/utils/filter-passes/llm-adv-memory-scrub-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * AdvancedMemoryScrubPass (conservative, stream-safe).
 *
 * Removes memory/system/internal dumps when clearly delimited.
 * Does not normalize whitespace or otherwise modify text.
 */
export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    let buf = (this.tail ?? "") + (chunk ?? "");
    const before = buf.length;

    // Fenced memory-like blocks
    buf = this.processFenced(buf, /```(?:memory|system|internal|policy|config|instructions?)[^\n]*\n/i, /```/i, "drop");

    // Structured "BEGIN ... END ..." sections
    buf = this.processBlocks(buf, /BEGIN\s+MEMORY\b/i, /END\s+MEMORY\b/i, "drop");
    buf = this.processBlocks(buf, /BEGIN\s+SYSTEM\s+PROMPT\b/i, /END\s+SYSTEM\s+PROMPT\b/i, "drop");
    buf = this.processBlocks(buf, /BEGIN\s+INTERNAL\b/i, /END\s+INTERNAL\b/i, "drop");
    buf = this.processBlocks(buf, /BEGIN\s+SCRATCHPAD\b/i, /END\s+SCRATCHPAD\b/i, "drop");

    // XML-ish variants
    buf = this.processBlocks(buf, /<\|memory_start\|>/i, /<\|memory_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<memory>/i, /<\/memory>/i, "drop");
    buf = this.processBlocks(buf, /<\|internal_start\|>/i, /<\|internal_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<internal>/i, /<\/internal>/i, "drop");
    buf = this.processBlocks(buf, /<\|system_prompt_start\|>/i, /<\|system_prompt_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<system_prompt>/i, /<\/system_prompt>/i, "drop");

    // Streaming safety: hold if tail looks like the start of any of these.
    const holdFrom = this.findHoldStart(buf);
    const cleaned = holdFrom === -1 ? buf : buf.slice(0, holdFrom);
    this.tail = holdFrom === -1 ? "" : buf.slice(holdFrom);

    const removed = before - (cleaned.length + this.tail.length);
    return { cleaned, removed: removed > 0 ? removed : 0 };
  }

  flush(): string {
    let buf = this.tail;
    this.tail = "";

    // If any fenced-memory start remains, drop from that start.
    const fenceIdx = this.findIndexOf(buf, /```(?:memory|system|internal|policy|config|instructions?)[^\n]*\n/i, 0);
    if (fenceIdx !== -1) buf = buf.slice(0, fenceIdx);

    // For structured sections, drop from unmatched start
    const specs: Array<{ s: RegExp; e: RegExp }> = [
      { s: /BEGIN\s+MEMORY\b/i,          e: /END\s+MEMORY\b/i },
      { s: /BEGIN\s+SYSTEM\s+PROMPT\b/i, e: /END\s+SYSTEM\s+PROMPT\b/i },
      { s: /BEGIN\s+INTERNAL\b/i,        e: /END\s+INTERNAL\b/i },
      { s: /BEGIN\s+SCRATCHPAD\b/i,      e: /END\s+SCRATCHPAD\b/i },
      { s: /<\|memory_start\|>/i,        e: /<\|memory_end\|>/i },
      { s: /<memory>/i,                  e: /<\/memory>/i },
      { s: /<\|internal_start\|>/i,      e: /<\|internal_end\|>/i },
      { s: /<internal>/i,                e: /<\/internal>/i },
      { s: /<\|system_prompt_start\|>/i, e: /<\|system_prompt_end\|>/i },
      { s: /<system_prompt>/i,           e: /<\/system_prompt>/i },
    ];
    for (const spec of specs) {
      const i = this.findIndexOf(buf, spec.s, 0);
      if (i !== -1 && this.findIndexOf(buf, spec.e, i + 1) === -1) {
        buf = buf.slice(0, i);
      }
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
      if (/^<\|?(?:memory|internal|system_prompt)/i.test(tail) && !/[>]/.test(tail)) return lastLt;
    }
    const lastTicks = s.lastIndexOf("```");
    if (lastTicks !== -1) {
      const tail = s.slice(lastTicks);
      if (/^```(?:memory|system|internal|policy|config|instructions?)/i.test(tail) &&
          !/```/.test(tail.slice(3))) return lastTicks;
    }
    if (/BEGIN\s+(?:MEMORY|SYSTEM\s+PROMPT|INTERNAL|SCRATCHPAD)\s*$/i.test(s)) {
      const m = s.match(/BEGIN\s+(MEMORY|SYSTEM\s+PROMPT|INTERNAL|SCRATCHPAD)\s*$/i);
      if (m && m.index !== undefined) return m.index;
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

export default AdvancedMemoryScrubPass;
