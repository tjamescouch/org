// src/utils/llm-noise-filter.ts
import type { LLMNoiseFilterPass } from "./filter-passes/llm-noise-filter-pass";
import { PDAStreamFilter } from "./filter-passes/llm-pda-stream";

export class LLMNoiseFilter {
  private readonly passes: LLMNoiseFilterPass[] = [new PDAStreamFilter()];

  feed(chunk: string): { cleaned: string; removed: number } {
    let cleaned = chunk ?? "";
    let removedTotal = 0; //deprecated
    for (const pass of this.passes) {
      const r = pass.feed(cleaned).cleaned ?? "";
      cleaned = r ?? cleaned;
    }
    return { cleaned, removed: 0 };
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
}

export default LLMNoiseFilter;
