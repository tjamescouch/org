// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * ToolformerSentinelPass
 *
 * Removes tool-calling scaffolding and metadata while preserving
 * user-facing tool results (when clearly marked as results/outputs).
 *
 * Recognized patterns (case-insensitive):
 *  - <|tool_call_start|> ... <|tool_call_end|>          => DROP CONTENT
 *  - <|tool_invocation_start|> ... <|tool_invocation_end|> => DROP CONTENT
 *  - <|tool_result_start|> ... <|tool_result_end|>      => KEEP INNER, DROP TAGS
 *  - <|tool_output_start|> ... <|tool_output_end|>      => KEEP INNER, DROP TAGS
 *  - <tool_call> ... </tool_call>                       => DROP CONTENT
 *  - <tool> ... </tool>                                 => DROP CONTENT
 *  - <tool_output> ... </tool_output>                   => KEEP INNER, DROP TAGS
 *  - ```tool ... ``` or ```toolformer ... ```           => DROP CONTENT BLOCK
 *
 * Also drops single tokens like <|tool_call|>, <|tool_result|> when present.
 *
 * Stream-safety: if a start marker arrives without its end, that start (and following)
 * is buffered until a matching end appears or flush() is called.
 */
export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private tail = "";

  private readonly singletons: RegExp[] = [
    /<\|tool_[A-Za-z0-9:_\-]+?\|>/gi, // drops single-tool sentinels (e.g., <|tool_call|>, <|tool_result|>, etc.)
  ];

  private readonly blockSpecs: ReadonlyArray<{
    start: RegExp;
    end: RegExp;
    mode: "drop" | "unwrap";
  }> = [
    { start: /<\|tool_call_start\|>/i,        end: /<\|tool_call_end\|>/i,        mode: "drop"   },
    { start: /<\|tool_invocation_start\|>/i,  end: /<\|tool_invocation_end\|>/i,  mode: "drop"   },
    { start: /<\|tool_result_start\|>/i,      end: /<\|tool_result_end\|>/i,      mode: "unwrap" },
    { start: /<\|tool_output_start\|>/i,      end: /<\|tool_output_end\|>/i,      mode: "unwrap" },
    { start: /<tool_call>/i,                  end: /<\/tool_call>/i,              mode: "drop"   },
    { start: /<tool>/i,                       end: /<\/tool>/i,                   mode: "drop"   },
    { start: /<tool_output>/i,                end: /<\/tool_output>/i,            mode: "unwrap" },
  ];

  // ```tool ...``` or ```toolformer ...```
  private readonly fencedToolStart = /```(?:tool|toolformer)[^\n]*\n/i;
  private readonly fencedEnd = /```/i;

  feed(chunk: string): PassFeedResult {
    const incoming = (chunk ?? "");
    let buf = this.tail + incoming;
    const beforeLen = buf.length;

    // Remove simple tool singletons first
    for (const re of this.singletons) {
      buf = buf.replace(re, "");
    }

    // Process all complete fenced tool blocks
    buf = this.removeAllFencedToolBlocks(buf);

    // Process structured block specs repeatedly until stable for this chunk
    buf = this.processAllBlocks(buf);

    // Determine safe emit point: if any unmatched start remains, keep from the earliest unmatched start.
    const holdFrom = this.findEarliestUnmatchedStart(buf);
    const emitUpto = holdFrom ?? buf.length;

    const cleaned = buf.slice(0, emitUpto);
    this.tail = buf.slice(emitUpto);

    const removed = beforeLen - (cleaned.length + this.tail.length);
    return { cleaned, removed: removed > 0 ? removed : 0 };
  }

  flush(): string {
    // On flush, drop any remaining "drop" blocks from their start,
    // and unwrap remaining "unwrap" blocks by removing the start tag only.
    let buf = this.tail;
    this.tail = "";

    // If we still have a fenced tool block start with no end, drop from start.
    const fencedStartIdx = this.indexOfRegex(buf, this.fencedToolStart, 0);
    if (fencedStartIdx !== -1) {
      buf = buf.slice(0, fencedStartIdx);
    }

    // For remaining structured blocks:
    for (const spec of this.blockSpecs) {
      let idxStart = this.indexOfRegex(buf, spec.start, 0);
      while (idxStart !== -1) {
        const idxEnd = this.indexOfRegex(buf, spec.end, idxStart + 1);
        if (idxEnd === -1) {
          // Unclosed block on flush
          if (spec.mode === "drop") {
            buf = buf.slice(0, idxStart);
          } else {
            // unwrap: remove just the start tag
            const startMatch = buf.slice(idxStart).match(spec.start);
            const startLen = startMatch?.[0]?.length ?? 0;
            buf = buf.slice(0, idxStart) + buf.slice(idxStart + startLen);
          }
          break; // move on to next spec after mutating
        } else {
          // closed block; perform final processing
          const startMatch = buf.slice(idxStart).match(spec.start);
          const endMatch = buf.slice(idxEnd).match(spec.end);
          const startLen = startMatch?.[0]?.length ?? 0;
          const endLen = endMatch?.[0]?.length ?? 0;

          if (spec.mode === "drop") {
            buf = buf.slice(0, idxStart) + buf.slice(idxEnd + endLen);
          } else {
            const inner = buf.slice(idxStart + startLen, idxEnd);
            buf = buf.slice(0, idxStart) + inner + buf.slice(idxEnd + endLen);
          }
          idxStart = this.indexOfRegex(buf, spec.start, idxStart);
        }
      }
    }

    // Clean up any stray singletons left
    for (const re of this.singletons) {
      buf = buf.replace(re, "");
    }

    return buf;
  }

  // ---- helpers ----

  private processAllBlocks(s: string): string {
    let changed = true;
    while (changed) {
      const before = s;
      for (const spec of this.blockSpecs) {
        s = this.processOneBlockType(s, spec.start, spec.end, spec.mode);
      }
      changed = s !== before;
    }
    return s;
  }

  private processOneBlockType(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let searchFrom = 0;
    while (true) {
      const idxStart = this.indexOfRegex(s, start, searchFrom);
      if (idxStart === -1) break;

      const idxEnd = this.indexOfRegex(s, end, idxStart + 1);
      if (idxEnd === -1) {
        // leave unmatched start for stream-safety
        break;
      }

      const startMatch = s.slice(idxStart).match(start);
      const endMatch = s.slice(idxEnd).match(end);
      const startLen = startMatch?.[0]?.length ?? 0;
      const endLen = endMatch?.[0]?.length ?? 0;

      if (mode === "drop") {
        s = s.slice(0, idxStart) + s.slice(idxEnd + endLen);
        searchFrom = idxStart; // continue from where we modified
      } else {
        const inner = s.slice(idxStart + startLen, idxEnd);
        s = s.slice(0, idxStart) + inner + s.slice(idxEnd + endLen);
        searchFrom = idxStart + inner.length;
      }
    }
    return s;
  }

  private removeAllFencedToolBlocks(s: string): string {
    let searchFrom = 0;
    while (true) {
      const startIdx = this.indexOfRegex(s, this.fencedToolStart, searchFrom);
      if (startIdx === -1) break;
      const startMatch = s.slice(startIdx).match(this.fencedToolStart);
      const startLen = startMatch?.[0]?.length ?? 0;

      const endIdx = this.indexOfRegex(s, this.fencedEnd, startIdx + startLen);
      if (endIdx === -1) {
        // hold incomplete block for streaming: stop here
        break;
      }
      const endMatch = s.slice(endIdx).match(this.fencedEnd);
      const endLen = endMatch?.[0]?.length ?? 0;

      // Drop the whole fenced block
      s = s.slice(0, startIdx) + s.slice(endIdx + endLen);
      searchFrom = startIdx;
    }
    return s;
  }

  private findEarliestUnmatchedStart(s: string): number | null {
    let h: number | null = null;

    // Check structured starts
    for (const spec of this.blockSpecs) {
      const idxStart = this.indexOfRegex(s, spec.start, 0);
      if (idxStart !== -1) {
        const idxEnd = this.indexOfRegex(s, spec.end, idxStart + 1);
        if (idxEnd === -1) {
          h = h === null ? idxStart : Math.min(h, idxStart);
        }
      }
    }

    // Check fenced tool start
    const fencedIdx = this.indexOfRegex(s, this.fencedToolStart, 0);
    if (fencedIdx !== -1) {
      const endIdx = this.indexOfRegex(s, this.fencedEnd, fencedIdx + 1);
      if (endIdx === -1) {
        h = h === null ? fencedIdx : Math.min(h, fencedIdx);
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

export default ToolformerSentinelPass;
