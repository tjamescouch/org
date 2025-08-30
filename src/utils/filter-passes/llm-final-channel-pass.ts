// src/utils/filter-passes/llm-final-channel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * FinalChannelPass: buffered + fence‑aware.
 *
 * Drops analysis/scratchpad blocks and unwraps explicit final blocks.
 * Never leaks partial starts; generic code fences are preserved.
 */
export class FinalChannelPass implements LLMNoiseFilterPass {
  private buf = "";

  private readonly startLiterals = [
    "<|analysis_start|>", "<analysis>",
    "<|scratchpad_start|>", "<scratchpad>",
    "<|final_start|>", "<final>",
  ];

  feed(chunk: string): PassFeedResult {
    this.buf += chunk ?? "";

    const { masked, fences } = this.maskCompleteFences(this.buf);
    let work = masked;

    // Drop closed analysis/scratchpad blocks
    work = this.resolveClosed(work, /<\|analysis_start\|>/i, /<\|analysis_end\|>/i, "drop");
    work = this.resolveClosed(work, /<analysis>/i, /<\/analysis>/i, "drop");
    work = this.resolveClosed(work, /<\|scratchpad_start\|>/i, /<\|scratchpad_end\|>/i, "drop");
    work = this.resolveClosed(work, /<scratchpad>/i, /<\/scratchpad>/i, "drop");

    // Unwrap closed final blocks
    work = this.resolveClosed(work, /<\|final_start\|>/i, /<\|final_end\|>/i, "unwrap");
    work = this.resolveClosed(work, /<final>/i, /<\/final>/i, "unwrap");

    this.buf = this.unmask(fences, work);

    // Hold from: open fence, unmatched starts, or partial start literal at tail
    let holdAt: number | null = null;
    const fenceStart = this.findUnmatchedFenceStart(this.buf);
    if (fenceStart !== -1) holdAt = fenceStart;

    const specs: Array<{ s: RegExp; e: RegExp }> = [
      { s: /<\|analysis_start\|>/i,   e: /<\|analysis_end\|>/i },
      { s: /<analysis>/i,             e: /<\/analysis>/i },
      { s: /<\|scratchpad_start\|>/i, e: /<\|scratchpad_end\|>/i },
      { s: /<scratchpad>/i,           e: /<\/scratchpad>/i },
      { s: /<\|final_start\|>/i,      e: /<\|final_end\|>/i },
      { s: /<final>/i,                e: /<\/final>/i },
    ];
    for (const spec of specs) {
      const i = this.earliestUnmatchedStart(this.buf, spec.s, spec.e);
      if (i !== null) holdAt = holdAt === null ? i : Math.min(holdAt, i);
    }

    const partialIdx = this.partialStartAtTail(this.buf, this.startLiterals);
    if (partialIdx !== null) holdAt = holdAt === null ? partialIdx : Math.min(holdAt, partialIdx);

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

  // ---- helpers (same patterns as toolformer) ----

  private resolveClosed(s: string, start: RegExp, end: RegExp, mode: "drop" | "unwrap"): string {
    const pair = new RegExp(`${start.source}([\\s\\S]*?)${end.source}`, "gi");
    let prev: string;
    do {
      prev = s;
      s = s.replace(pair, (_m, inner: string) => (mode === "drop" ? "" : inner));
    } while (s !== prev);
    return s;
  }

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
    if (lower.endsWith("<")) {
      const idx = lower.length - 1;
      best = best === null ? idx : Math.min(best, idx);
    }
    return best;
  }

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

export default FinalChannelPass;
