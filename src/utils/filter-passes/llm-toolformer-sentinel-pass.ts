// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * ToolformerSentinelPass: stream-safe, fence-aware.
 * - Works only outside generic code fences.
 * - Drops: <|tool_call_start|> ... <|tool_call_end|>, <tool_call>...</tool_call>, <tool>...</tool>
 * - Unwraps (keep inner): <|tool_result_start|>...<|tool_result_end|>, <|tool_output_start|>...<|tool_output_end|>, <tool_output>...</tool_output>
 * - Drops singletons like <|tool_call|>, <|tool_result|>, <|tool_output|>, <|tool_invocation|>.
 * - Holds from the earliest unmatched *start* until the corresponding *end* arrives.
 */
export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private tail = "";

  private readonly specs: ReadonlyArray<{ start: RegExp; end: RegExp; mode: "drop" | "unwrap" }> = [
    { start: /<\|tool_call_start\|>/i,       end: /<\|tool_call_end\|>/i,       mode: "drop"   },
    { start: /<\|tool_invocation_start\|>/i, end: /<\|tool_invocation_end\|>/i, mode: "drop"   },
    { start: /<\|tool_result_start\|>/i,     end: /<\|tool_result_end\|>/i,     mode: "unwrap" },
    { start: /<\|tool_output_start\|>/i,     end: /<\|tool_output_end\|>/i,     mode: "unwrap" },
    { start: /<tool_call>/i,                 end: /<\/tool_call>/i,             mode: "drop"   },
    { start: /<tool>/i,                      end: /<\/tool>/i,                  mode: "drop"   },
    { start: /<tool_output>/i,               end: /<\/tool_output>/i,           mode: "unwrap" },
  ];

  feed(chunk: string): PassFeedResult {
    const input = (this.tail ?? "") + (chunk ?? "");

    // 1) If a generic code fence is open, hold from that start.
    const holdFenceAt = this.findUnmatchedFenceStart(input);
    const pre = holdFenceAt === -1 ? input : input.slice(0, holdFenceAt);
    const post = holdFenceAt === -1 ? "" : input.slice(holdFenceAt);

    // 2) Split `pre` into fence + text segments (absolute offsets).
    const segs = this.splitCompleteFences(pre);

    let cleaned = "";
    let holdFromAbs: number | null = null;

    for (const seg of segs) {
      if (seg.type === "fence") {
        cleaned += pre.slice(seg.start, seg.end); // preserve fences verbatim
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

    // 3) Hold partial sentinel at end (e.g., "<", "<|tool", "<|tool_call_start|")
    const partialFrom = this.findPartialSentinelStart(cleaned, /^<\|?tool/i);
    if (partialFrom !== -1) {
      this.tail = cleaned.slice(partialFrom) + post;
      cleaned = cleaned.slice(0, partialFrom);
      return { cleaned, removed: input.length - (cleaned.length + this.tail.length) };
    }

    this.tail = post;
    return { cleaned, removed: input.length - (cleaned.length + this.tail.length) };
  }

  flush(): string {
    const out = this.tail;
    this.tail = "";
    return out;
  }

  // ---- block processing outside fences ----

  private processOutside(s: string): { processed: string; holdFrom: number } {
    let work = s;

    // First, resolve any *closed* blocks repeatedly until stable.
    let changed = true;
    while (changed) {
      const before = work;
      for (const spec of this.specs) {
        work = this.resolveClosedBlocks(work, spec.start, spec.end, spec.mode);
      }
      changed = work !== before;
    }

    // Next, if any unmatched start remains, HOLD from the earliest one.
    let holdFrom = -1;
    for (const spec of this.specs) {
      const i = this.indexOfRegex(work, spec.start, 0);
      if (i !== -1 && this.indexOfRegex(work, spec.end, i + 1) === -1) {
        holdFrom = holdFrom === -1 ? i : Math.min(holdFrom, i);
      }
    }
    if (holdFrom !== -1) return { processed: work.slice(0, holdFrom), holdFrom };

    // Finally, drop simple singletons.
    work = work.replace(/<\|tool_(?:call|result|output|invocation)\|>/gi, "");

    return { processed: work, holdFrom: -1 };
  }

  private resolveClosedBlocks(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let from = 0;
    while (true) {
      const i = this.indexOfRegex(s, start, from);
      if (i === -1) break;
      const j = this.indexOfRegex(s, end, i + 1);
      if (j === -1) break; // leave unmatched for streaming
      const startLen = s.slice(i).match(start)?.[0].length ?? 0;
      const endLen = s.slice(j).match(end)?.[0].length ?? 0;
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

  // ---- generic fence helpers + partial hold ----

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

export default ToolformerSentinelPass;
