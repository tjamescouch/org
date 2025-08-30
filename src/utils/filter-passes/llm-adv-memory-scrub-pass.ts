// src/utils/filter-passes/llm-adv-memory-scrub-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * AdvancedMemoryScrubPass: buffered + fence‑aware.
 *
 * Drops memory/system/internal dumps when closed; never leaks partial starts.
 * Generic code fences (```lang … ```) are preserved verbatim.
 */
export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private buf = "";

  private readonly startLiterals = [
    "<|memory_start|>", "<memory>",
    "<|internal_start|>", "<internal>",
    "<|system_prompt_start|>", "<system_prompt>",
    "begin memory", "begin system prompt", "begin internal", "begin scratchpad",
  ];

  feed(chunk: string): PassFeedResult {
    this.buf += chunk ?? "";

    const { masked, fences } = this.maskCompleteFences(this.buf);
    let work = masked;

    // Drop closed XML-ish regions
    work = this.resolveClosed(work, /<\|memory_start\|>/i, /<\|memory_end\|>/i);
    work = this.resolveClosed(work, /<memory>/i, /<\/memory>/i);
    work = this.resolveClosed(work, /<\|internal_start\|>/i, /<\|internal_end\|>/i);
    work = this.resolveClosed(work, /<internal>/i, /<\/internal>/i);
    work = this.resolveClosed(work, /<\|system_prompt_start\|>/i, /<\|system_prompt_end\|>/i);
    work = this.resolveClosed(work, /<system_prompt>/i, /<\/system_prompt>/i);

    // Drop closed BEGIN...END textual regions
    work = this.resolveClosed(work, /BEGIN\s+MEMORY\b/i, /END\s+MEMORY\b/i);
    work = this.resolveClosed(work, /BEGIN\s+SYSTEM\s+PROMPT\b/i, /END\s+SYSTEM\s+PROMPT\b/i);
    work = this.resolveClosed(work, /BEGIN\s+INTERNAL\b/i, /END\s+INTERNAL\b/i);
    work = this.resolveClosed(work, /BEGIN\s+SCRATCHPAD\b/i, /END\s+SCRATCHPAD\b/i);

    this.buf = this.unmask(fences, work);

    // Hold from open fence, unmatched start tags, or partial starts at tail
    let holdAt: number | null = null;
    const fenceStart = this.findUnmatchedFenceStart(this.buf);
    if (fenceStart !== -1) holdAt = fenceStart;

    const specs: Array<{ s: RegExp; e: RegExp }> = [
      { s: /<\|memory_start\|>/i,        e: /<\|memory_end\|>/i },
      { s: /<memory>/i,                  e: /<\/memory>/i },
      { s: /<\|internal_start\|>/i,      e: /<\|internal_end\|>/i },
      { s: /<internal>/i,                e: /<\/internal>/i },
      { s: /<\|system_prompt_start\|>/i, e: /<\|system_prompt_end\|>/i },
      { s: /<system_prompt>/i,           e: /<\/system_prompt>/i },
      { s: /BEGIN\s+MEMORY\b/i,          e: /END\s+MEMORY\b/i },
      { s: /BEGIN\s+SYSTEM\s+PROMPT\b/i, e: /END\s+SYSTEM\s+PROMPT\b/i },
      { s: /BEGIN\s+INTERNAL\b/i,        e: /END\s+INTERNAL\b/i },
      { s: /BEGIN\s+SCRATCHPAD\b/i,      e: /END\s+SCRATCHPAD\b/i },
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

  // ---- helpers ----

  private resolveClosed(s: string, start: RegExp, end: RegExp): string {
    const pair = new RegExp(`${start.source}([\\s\\S]*?)${end.source}`, "gi");
    let prev: string;
    do {
      prev = s;
      s = s.replace(pair, "");
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

export default AdvancedMemoryScrubPass;
