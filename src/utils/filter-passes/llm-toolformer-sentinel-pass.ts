// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * ToolformerSentinelPass: buffered + fence‑aware.
 *
 * Drops tool scaffolding blocks and unwraps tool results, without ever leaking
 * partial starts. Generic code fences (```lang … ```) are preserved verbatim.
 */
export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private buf = "";

  // Literal starts for partial-prefix detection at tail:
  private readonly startLiterals = [
    "<|tool_call_start|>",
    "<|tool_invocation_start|>",
    "<|tool_result_start|>",
    "<|tool_output_start|>",
    "<tool_call>",
    "<tool>",
    "<tool_output>",
  ];

  feed(chunk: string): PassFeedResult {
    this.buf += chunk ?? "";

    // 1) Protect complete generic fences while transforming closed blocks.
    const { masked, fences } = this.maskCompleteFences(this.buf);
    let work = masked;

    // 2) Resolve all closed pairs repeatedly (drop/unwrap)
    work = this.resolveClosed(work, /<\|tool_call_start\|>/i, /<\|tool_call_end\|>/i, "drop");
    work = this.resolveClosed(work, /<\|tool_invocation_start\|>/i, /<\|tool_invocation_end\|>/i, "drop");
    work = this.resolveClosed(work, /<\|tool_result_start\|>/i, /<\|tool_result_end\|>/i, "unwrap");
    work = this.resolveClosed(work, /<\|tool_output_start\|>/i, /<\|tool_output_end\|>/i, "unwrap");
    work = this.resolveClosed(work, /<tool_call>/i, /<\/tool_call>/i, "drop");
    work = this.resolveClosed(work, /<tool>/i, /<\/tool>/i, "drop");
    work = this.resolveClosed(work, /<tool_output>/i, /<\/tool_output>/i, "unwrap");

    // Drop simple singletons anywhere outside fences
    work = work.replace(/<\|tool_(?:call|result|output|invocation)\|>/gi, "");

    // Restore fences
    this.buf = this.unmask(fences, work);

    // 3) Compute earliest hold index
    let holdAt: number | null = null;

    // 3a) Unmatched generic fence start
    const fenceStart = this.findUnmatchedFenceStart(this.buf);
    if (fenceStart !== -1) holdAt = fenceStart;

    // 3b) Any unmatched tool block start (exact start present; end missing)
    const specs: Array<{ s: RegExp; e: RegExp }> = [
      { s: /<\|tool_call_start\|>/i,       e: /<\|tool_call_end\|>/i },
      { s: /<\|tool_invocation_start\|>/i, e: /<\|tool_invocation_end\|>/i },
      { s: /<\|tool_result_start\|>/i,     e: /<\|tool_result_end\|>/i },
      { s: /<\|tool_output_start\|>/i,     e: /<\|tool_output_end\|>/i },
      { s: /<tool_call>/i,                 e: /<\/tool_call>/i },
      { s: /<tool>/i,                      e: /<\/tool>/i },
      { s: /<tool_output>/i,               e: /<\/tool_output>/i },
    ];
    for (const spec of specs) {
      const i = this.earliestUnmatchedStart(this.buf, spec.s, spec.e);
      if (i !== null) holdAt = holdAt === null ? i : Math.min(holdAt, i);
    }

    // 3c) Partial start literal at tail (e.g., "<", "<|tool", "<|tool_call_sta")
    const partialIdx = this.partialStartAtTail(this.buf, this.startLiterals);
    if (partialIdx !== null) holdAt = holdAt === null ? partialIdx : Math.min(holdAt, partialIdx);

    // 4) Emit safe prefix
    let cleaned: string;
    if (holdAt === null) {
      cleaned = this.buf;
      this.buf = "";
    } else {
      cleaned = this.buf.slice(0, holdAt);
      this.buf = this.buf.slice(holdAt);
    }
    return { cleaned, removed: 0 };
  }

  flush(): string {
    const out = this.buf;
    this.buf = "";
    return out;
  }

  // ---------- transforms ----------

  private resolveClosed(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    const pair = new RegExp(`${start.source}([\\s\\S]*?)${end.source}`, "gi");
    let prev: string;
    do {
      prev = s;
      s = s.replace(pair, (_m, inner: string) => (mode === "drop" ? "" : inner));
    } while (s !== prev);
    return s;
  }

  // ---------- holds ----------

  private earliestUnmatchedStart(s: string, start: RegExp, end: RegExp): number | null {
    let from = 0;
    while (true) {
      const i = this.indexOfRegex(s, start, from);
      if (i === -1) return null;
      const j = this.indexOfRegex(s, end, i + 1);
      if (j === -1) return i;
      const endLen = s.slice(j).match(end)?.[0].length ?? 0;
      from = j + endLen;
    }
  }

  private partialStartAtTail(s: string, literals: string[]): number | null {
    const lower = s.toLowerCase();
    let best: number | null = null;
    for (const lit of literals) {
      const L = lit.toLowerCase();
      const max = Math.min(L.length - 1, lower.length);
      for (let k = max; k >= 1; k--) {
        if (L.startsWith(lower.slice(lower.length - k))) {
          const idx = lower.length - k;
          best = best === null ? idx : Math.min(best, idx);
          break;
        }
      }
    }
    // also catch a bare '<' at the very end
    if (lower.endsWith("<")) {
      const idx = lower.length - 1;
      best = best === null ? idx : Math.min(best, idx);
    }
    return best;
  }

  // ---------- fences ----------

  private maskCompleteFences(s: string): { masked: string; fences: string[] } {
    let out = "";
    let pos = 0;
    const fences: string[] = [];
    while (true) {
      const i = s.indexOf("```", pos);
      if (i === -1) break;
      const nl = s.indexOf("\n", i + 3);
      if (nl === -1) break;
      const j = s.indexOf("```", nl + 1);
      if (j === -1) break;
      fences.push(s.slice(i, j + 3));
      out += s.slice(pos, i) + this.placeholder(fences.length - 1);
      pos = j + 3;
    }
    out += s.slice(pos);
    return { masked: out, fences };
  }

  private unmask(fences: string[], s: string): string {
    return s.replace(/\u0000F(\d+)\u0000/g, (_m, g1: string) => {
      const k = Number(g1);
      return Number.isFinite(k) && fences[k] !== undefined ? fences[k] : _m;
    });
  }

  private placeholder(i: number): string { return `\u0000F${i}\u0000`; }

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

  private indexOfRegex(s: string, re: RegExp, from: number): number {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    r.lastIndex = from;
    const m = r.exec(s);
    return m ? m.index : -1;
  }
}

export default ToolformerSentinelPass;
