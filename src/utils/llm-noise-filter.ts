// src/utils/llm-noise-filter.ts
//
// LLMNoiseFilter (public API unchanged):
//   - feed(chunk: string): { cleaned: string; removed: number }
//   - flush(): string
// Convenience (kept, some tests use these):
//   - push(chunk: string): string  // returns cleaned
//   - end(): string                // returns flush()
//
// Internally, the filter runs composable passes outside fences, in order:
//   1) LLMNoiseFilterFirstPass (strip non-final toolformer sentinels; preserve fences; carry fence tails)
//   2) FinalChannelPass (extract <|channel|>final … <|message|> payload; unwrap commentary JSON/echo)
//   3) AdvancedMemoryScrubPass (safe scrubs for banners/debug)
//
// The first pass preserves all historical behavior the tests assert.

import { LLMNoiseFilterFirstPass } from "./filter-passes/llm-noise-filter-first-pass";
import { FinalChannelPass } from "./filter-passes/llm-final-channel-pass";
import { AdvancedMemoryScrubPass } from "./filter-passes/llm-adv-memory-scrub-pass";

export class LLMNoiseFilter {
  private first = new LLMNoiseFilterFirstPass();
  private finalMsg = new FinalChannelPass();
  private advScrub = new AdvancedMemoryScrubPass();

  // --- public API (unchanged) ---

  feed(chunk: string): { cleaned: string; removed: number } {
    // 1) Run the historical sentinel/fence logic (this carries fence tails).
    const firstOut = this.first.feed(chunk);
    let cleaned = firstOut.cleaned;

    // 2) Then run the final-message extractor (has its own carry for partial tags).
    cleaned = this.finalMsg.feed(cleaned);

    // 3) Then the conservative scrubs (no special carry needed today, but the class supports it).
    cleaned = this.advScrub.feed(cleaned);

    // `removed` tracks only toolformer sentinel removals (as before).
    return { cleaned, removed: firstOut.removed };
  }

  flush(): string {
    // Flush first pass (may return an incomplete fence tail), then pipe through other passes.
    let tail = this.first.flush();

    // Push that tail through remaining passes, then flush their tails too.
    tail = this.finalMsg.feed(tail) + this.finalMsg.flush();
    tail = this.advScrub.feed(tail) + this.advScrub.flush();

    return tail;
  }

  // Back-compat convenience (some tests call push/end instead of feed/flush).
  push(chunk: string): string {
    return this.feed(chunk).cleaned;
  }
  end(): string {
    return this.flush();
  }
}

export default LLMNoiseFilter;
