// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * ToolformerSentinelPass (conservative, stream-safe).
 *
 * Removes tool invocation scaffolding while preserving human‑readable results.
 * Only acts on clearly delimited blocks; otherwise it leaves text untouched.
 */
export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    let buf = (this.tail ?? "") + (chunk ?? "");
    const before = buf.length;

    // Drop obvious singletons like <|tool_call|>, <|tool_result|>, etc.
    buf = buf.replace(/<\|tool_(?:call|result|output|invocation)\|>/gi, "");

    // Structured starts/ends
    buf = this.processBlocks(buf, /<\|tool_call_start\|>/i, /<\|tool_call_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<\|tool_invocation_start\|>/i, /<\|tool_invocation_end\|>/i, "drop");
    buf = this.processBlocks(buf, /<\|tool_result_start\|>/i, /<\|tool_result_end\|>/i, "unwrap");
    buf = this.processBlocks(buf, /<\|tool_output_start\|>/i, /<\|tool_output_end\|>/i, "unwrap");

    // XML-ish variants
    buf = this.processBlocks(buf, /<tool_call>/i, /<\/tool_call>/i, "drop");
    buf = this.processBlocks(buf, /<tool>/i, /<\/tool>/i, "drop");
    buf = this.processBlocks(buf, /<tool_output>/i, /<\/tool_output>/i, "unwrap");

    // Fenced tool blocks: ```tool ... ``` or ```toolformer ... ``` => drop
    buf = this.processFenced(buf, /```(?:tool|toolformer)[^\n]*\n/i, /```/i, "drop");

    // Stream-safety: hold only if tail looks like a partial tool start
    const holdFrom = this.findHoldStart(buf);
    const cleaned = holdFrom === -1 ? buf : buf.slice(0, holdFrom);
    this.tail = holdFrom === -1 ? "" : buf.slice(holdFrom);

    const removed = before - (cleaned.length + this.tail.length);
    return { cleaned, removed: removed > 0 ? removed : 0 };
  }

  flush(): string {
    let buf = this.tail;
    this.tail = "";

    // On flush, drop/unwrap any blocks that are still open from their start.
    const fenceIdx = this.findIndexOf(buf, /```(?:tool|toolformer)[^\n]*\n/i, 0);
    if (fenceIdx !== -1) buf = buf.slice(0, fenceIdx);

    const specs: Array<{ s: RegExp; e: RegExp; mode: "drop" | "unwrap" }> = [
      { s: /<\|tool_call_start\|>/i,       e: /<\|tool_call_end\|>/i,       mode: "drop"   },
      { s: /<\|tool_invocation_start\|>/i, e: /<\|tool_invocation_end\|>/i, mode: "drop"   },
      { s: /<\|tool_result_start\|>/i,     e: /<\|tool_result_end\|>/i,     mode: "unwrap" },
      { s: /<\|tool_output_start\|>/i,     e: /<\|tool_output_end\|>/i,     mode: "unwrap" },
      { s: /<tool_call>/i,                 e: /<\/tool_call>/i,             mode: "drop"   },
      { s: /<tool>/i,                      e: /<\/tool>/i,                  mode: "drop"   },
      { s: /<tool_output>/i,               e: /<\/tool_output>/i,           mode: "unwrap" },
    ];
    for (const spec of specs) {
      const i = this.findIndexOf(buf, spec.s, 0);
      if (i !== -1 && this.findIndexOf(buf, spec.e, i + 1) === -1) {
        buf = spec.mode === "drop" ? buf.slice(0, i) : buf.slice(0, i) + buf.slice(i).replace(spec.s, "");
      }
    }

    // Clean leftover singletons
    buf = buf.replace(/<\|tool_(?:call|result|output|invocation)\|>/gi, "");

    return buf;
  }

  // ---- helpers ----

  private processBlocks(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    let from = 0;
    while (true) {
      const i = this.findIndexOf(s, start, from);
      if (i === -1) break;
      const j = this.findIndexOf(s, end, i + 1);
      if (j === -1) break; // leave unmatched for streaming
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
      if (/^<\|?tool/i.test(tail) && !/[>]/.test(tail)) return lastLt;
    }
    const lastTicks = s.lastIndexOf("```");
    if (lastTicks !== -1) {
      const tail = s.slice(lastTicks);
      if (/^```(?:tool|toolformer)/i.test(tail) && !/```/.test(tail.slice(3))) return lastTicks;
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

export default ToolformerSentinelPass;
