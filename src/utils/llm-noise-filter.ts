// src/utils/llm-noise-filter.ts
//
// Dynamic pass pipeline used both in post-turn cleaning and streaming.
// Public API preserved: feed(chunk): { cleaned, removed }, flush(): string

import type { LLMNoiseFilterPass, PassFeedResult } from "./filter-passes/llm-noise-filter-pass";
import { LLMNoiseFilterFirstPass } from "./filter-passes/llm-noise-filter-first-pass";
import { ToolformerSentinelPass } from "./filter-passes/llm-toolformer-sentinel-pass";
import { FinalChannelPass } from "./filter-passes/llm-final-channel-pass";
import { AdvancedMemoryScrubPass } from "./filter-passes/llm-adv-memory-scrub-pass";

export class LLMNoiseFilter {
  private readonly passes: LLMNoiseFilterPass[];

  constructor(passes: LLMNoiseFilterPass[]) {
    if (!Array.isArray(passes) || passes.length === 0) {
      throw new Error("LLMNoiseFilter requires at least one filter pass");
    }
    this.passes = passes.slice(); // do not mutate caller array
  }

  feed(chunk: string): { cleaned: string; removed: number } {
    let cleaned = chunk ?? "";
    let removedTotal = 0;

    for (const pass of this.passes) {
      const res: PassFeedResult = pass.feed(cleaned) ?? { cleaned };
      if (res && typeof res.cleaned === "string") {
        cleaned = res.cleaned;
      }
      if (typeof res?.removed === "number") {
        removedTotal += res.removed;
      }
    }
    return { cleaned, removed: removedTotal };
  }

  flush(): string {
    if (this.passes.length === 1) return this.passes[0].flush();

    let tail = this.passes[0].flush();
    for (let i = 1; i < this.passes.length; i++) {
      const p = this.passes[i];
      tail = p.feed(tail).cleaned + p.flush();
    }
    return tail;
  }

  push(chunk: string): string { return this.feed(chunk).cleaned; }
  end(): string { return this.flush(); }

  /** Standard pipeline: first-pass → toolformer → final-channel → advanced scrub. */
  static createDefault(): LLMNoiseFilter {
    return new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(),
      new ToolformerSentinelPass(),
      new FinalChannelPass(),
      new AdvancedMemoryScrubPass(),
    ]);
  }
}

export default LLMNoiseFilter;
