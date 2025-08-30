// src/utils/llm-noise-filter.ts
import { FinalChannelPass } from "./filter-passes/llm-final-channel-pass";
import { LLMNoiseFilterFirstPass } from "./filter-passes/llm-noise-filter-first-pass";
import { AdvancedMemoryScrubPass } from "./filter-passes/llm-adv-memory-scrub-pass";
import type { LLMNoiseFilterPass, PassFeedResult } from "./filter-passes/llm-noise-filter-pass";
import PDANoiseFilterPass from "./filter-passes/llm-pda-stream-pass";

export class LLMNoiseFilter {
  private readonly passes: LLMNoiseFilterPass[];
  constructor(passes: LLMNoiseFilterPass[]) {
    if (!passes?.length) throw new Error("LLMNoiseFilter requires at least one filter pass");
    this.passes = passes.slice();
  }

  feed(chunk: string): { cleaned: string; removed: number } {
    let cleaned = chunk ?? "";
    let removedTotal = 0;
    for (const pass of this.passes) {
      const r: PassFeedResult = pass.feed(cleaned) ?? { cleaned };
      cleaned = r.cleaned ?? cleaned;
      if (typeof r?.removed === "number") removedTotal += r.removed;
    }
    return { cleaned, removed: removedTotal };
  }

  flush(): string {
    if (this.passes.length === 1) return this.passes[0].flush().cleaned;
    let tail = this.passes[0].flush();
    for (let i = 1; i < this.passes.length; i++) {
      const p = this.passes[i];
      tail.cleaned = p.feed(tail.cleaned).cleaned + p.flush();
    }
    return tail.cleaned;
  }

  push(chunk: string): string { return this.feed(chunk).cleaned; }
  end(): string { return this.flush(); }

  static createDefault(): LLMNoiseFilter {
    return new LLMNoiseFilter([
      new PDANoiseFilterPass(),
    ]);
  }
}

export default LLMNoiseFilter;
