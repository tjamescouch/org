// src/utils/llm-noise-filter.ts
//
// LLMNoiseFilter (public API unchanged):
//   - feed(chunk: string): { cleaned: string; removed: number }
//   - flush(): string
// Convenience (kept for older tests):
//   - push(chunk: string): string
//   - end(): string
//
// Internals: passes outside fences, in order:
//   1) LLMNoiseFilterFirstPass          (historical sentinel/fence behavior)
//   2) FinalChannelPass                 (<|channel|>final … <|message|> payload + commentary unwrap)
//   3) AdvancedMemoryScrubPass          (safe scrubs)

import { LLMNoiseFilterFirstPass } from "./filter-passes/llm-noise-filter-first-pass";
import { FinalChannelPass } from "./filter-passes/llm-final-channel-pass";
import { AdvancedMemoryScrubPass } from "./filter-passes/llm-adv-memory-scrub-pass";

export class LLMNoiseFilter {
  private first = new LLMNoiseFilterFirstPass();
  private finalMsg = new FinalChannelPass();
  private advScrub = new AdvancedMemoryScrubPass();

  feed(chunk: string): { cleaned: string; removed: number } {
    const firstOut = this.first.feed(chunk);
    let cleaned = firstOut.cleaned;
    cleaned = this.finalMsg.feed(cleaned);
    cleaned = this.advScrub.feed(cleaned);
    return { cleaned, removed: firstOut.removed };
  }

  flush(): string {
    let tail = this.first.flush();
    tail = this.finalMsg.feed(tail) + this.finalMsg.flush();
    tail = this.advScrub.feed(tail) + this.advScrub.flush();
    return tail;
  }

  push(chunk: string): string { return this.feed(chunk).cleaned; }
  end(): string { return this.flush(); }
}

export default LLMNoiseFilter;
