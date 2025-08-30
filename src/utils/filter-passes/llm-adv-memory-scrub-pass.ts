// src/utils/filter-passes/llm-adv-memory-scrub-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * AdvancedMemoryScrubPass
 *
 * Final polish: remove any lingering internal/memory/system dumps, unmatched fences,
 * and normalize whitespace. Stream-safe via buffering incomplete blocks.
 *
 * Drops blocks for common memory-like regions:
 *  - <|memory_start|> ... <|memory_end|>
 *  - <memory> ... </memory>
 *  - BEGIN MEMORY ... END MEMORY   (case-insensitive)
 *  - BEGIN SYSTEM PROMPT ... END SYSTEM PROMPT
 *  - BEGIN INTERNAL ... END INTERNAL
 *  - ```memory / ```system / ```internal / ```policy / ```config ... ```
 *
 * Also trims leftover triple-backticks (unmatched) and collapses 3+ newlines.
 */
export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private tail = "";

  private readonly dropBlocks: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
    { start: /<\|memory_start\|>/i,         end: /<\|memory_end\|>/i },
    { start: /<memory>/i,                   end: /<\/memory>/i },
    { start: /<\|internal_start\|>/i,       end: /<\|internal_end\|>/i },
    { start: /<internal>/i,                 end: /<\/internal>/i },
    { start: /<\|system_prompt_start\|>/i,  end: /<\|system_prompt_end\|>/i },
    { start: /<system_prompt>/i,            end: /<\/system_prompt>/i },
    // Textual BEGIN/END sections
    { start: /BEGIN\s+MEMORY\b/i,           end: /END\s+MEMORY\b/i },
    { start: /BEGIN\s+SYSTEM\s+PROMPT\b/i,  end: /END\s+SYSTEM\s+PROMPT\b/i },
    { start: /BEGIN\s+INTERNAL\b/i,         end: /END\s+INTERNAL\b/i },
    { start: /BEGIN\s+SCRATCHPAD\b/i,       end: /END\s+SCRATCHPAD\b/i },
  ];

  // Fenced memory-like dumps
  private readonly fencedStart = /```(?:memory|system|internal|policy|config|instructions?)[^\n]*\n/i;
  private readonly fencedEnd = /```/i;

  feed(chunk: string): PassFeedResult {
    const incoming = (chunk ?? "");
    let buf = this.tail + incoming;
    const beforeLen = buf.length;

    // 1) Drop fenced memory-like blocks
    buf = this.removeAllFencedBlocks(buf);

    // 2) Drop structured blocks
    for (const spec of this.dropBlocks) {
      buf = this.dropBlockType(buf, spec.start, spec.end);
    }

    // 3) Clean stray ALL-CAPS bracketed “stage directions” lines (very conservative)
    buf = buf.replace(/^\s*(?:\[|\(|\{)\s*(?:INTERNAL|SYSTEM|POLICY|DO\s+NOT\s+SHARE|DEBUG|PLAN)\b.*?(?:\]|\)|\})\s*$/gim, "");

    // 4) Normalize whitespace a bit (no streaming harm)
    buf = this.normalizeWhitespace(buf);

    // Determine safe emit: if an unmatched start remains, hold from earliest
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

    // On flush, any remaining fenced start => drop from start
    const idxFence = this.indexOfRegex(buf, this.fencedStart, 0);
    if (idxFence !== -1) {
      buf = buf.slice(0, idxFence);
    }

    // Drop any remaining structured starts
    for (const spec of this.dropBlocks) {
      const i = this.indexOfRegex(buf, spec.start, 0);
      if (i !== -1) {
        buf = buf.slice(0, i);
      }
    }

    // Remove any orphan backtick fences to avoid leaking fence markers
    buf = buf.replace(/```[A-Za-z0-9_\-]*\s*$/g, ""); // orphan starting fence at end of stream
    buf = buf.replace(/^```$/gm, ""); // standalone lone fences

    // Final tidy
    buf = this.normalizeWhitespace(buf);
    return buf;
  }

  // ---- helpers ----

  private removeAllFencedBlocks(s: string): string {
    let from = 0;
    while (true) {
      const i = this.indexOfRegex(s, this.fencedStart, from);
      if (i === -1) break;
      const sm = s.slice(i).match(this.fencedStart);
      const sLen = sm?.[0]?.length ?? 0;

      const j = this.indexOfRegex(s, this.fencedEnd, i + sLen);
      if (j === -1) {
        // hold unmatched for streaming
        break;
      }
      const eLen = s.slice(j).match(this.fencedEnd)?.[0]?.length ?? 0;

      s = s.slice(0, i) + s.slice(j + eLen);
      from = i;
    }
    return s;
  }

  private dropBlockType(s: string, start: RegExp, end: RegExp): string {
    let from = 0;
    while (true) {
      const i = this.indexOfRegex(s, start, from);
      if (i === -1) break;
      const j = this.indexOfRegex(s, end, i + 1);
      if (j === -1) break; // leave unmatched for streaming
      const startLen = s.slice(i).match(start)?.[0]?.length ?? 0;
      const endLen = s.slice(j).match(end)?.[0]?.length ?? 0;
      s = s.slice(0, i) + s.slice(j + endLen);
      from = i;
    }
    return s;
  }

  private normalizeWhitespace(s: string): string {
    // collapse 3+ newlines to 2, trim trailing spaces at line ends
    return s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  }

  private findEarliestUnmatchedStart(s: string): number | null {
    let h: number | null = null;

    const fenceIdx = this.indexOfRegex(s, this.fencedStart, 0);
    if (fenceIdx !== -1 && this.indexOfRegex(s, this.fencedEnd, fenceIdx + 1) === -1) {
      h = fenceIdx;
    }

    for (const spec of this.dropBlocks) {
      const i = this.indexOfRegex(s, spec.start, 0);
      if (i !== -1 && this.indexOfRegex(s, spec.end, i + 1) === -1) {
        h = h === null ? i : Math.min(h, i);
      }
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

export default AdvancedMemoryScrubPass;
