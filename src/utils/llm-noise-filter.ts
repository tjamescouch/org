// src/utils/llm-noise-filter.ts
import type { LLMNoiseFilterPass } from "./filter-passes/llm-noise-filter-pass";
import { LLMNoisePDAStream } from "./filter-passes/llm-pda-stream";

export class LLMNoiseFilter {
  private readonly passes: LLMNoiseFilterPass[] = [];

  feed(chunk: string): string {
    let cleaned = chunk ?? "";
    for (const pass of this.passes) {
      const r = pass.feed(cleaned) ?? "";
      cleaned = r ?? cleaned;
    }
    return cleaned;
  }

  flush(): string {
    if (this.passes.length === 1) return this.passes[0].flush();
    let tail = this.passes[0].flush();
    for (let i = 1; i < this.passes.length; i++) {
      const p = this.passes[i];
      tail = p.feed(tail) + p.flush();
    }
    return tail;
  }

  push(chunk: string): string { return this.feed(chunk); }
  end(): string { return this.flush(); }
}

export default LLMNoiseFilter;
