import type { LLMNoiseFilterPass, PassFeedResult } from "./filter-passes/llm-noise-filter-pass";

export class LLMNoiseFilter {
  // Keep our own copy so callers can't mutate the live pipeline after construction.
  private readonly passes: LLMNoiseFilterPass[];

  constructor(passes: LLMNoiseFilterPass[]) {
    if (!Array.isArray(passes) || passes.length === 0) {
      throw new Error("LLMNoiseFilter requires at least one filter pass");
    }
    this.passes = passes.slice();
  }

  /**
   * Push a chunk through the pipeline, left-to-right.
   * - Each pass may alter the text and optionally report "removed" counts.
   * - We sum removed across passes.
   */
  feed(chunk: string): { cleaned: string; removed: number } {
    let cleaned = chunk ?? "";
    let removedTotal = 0;

    for (const pass of this.passes) {
      const res: PassFeedResult = pass.feed(cleaned) ?? { cleaned };
      cleaned = res.cleaned;
      if (typeof res.removed === "number") removedTotal += res.removed;
    }

    return { cleaned, removed: removedTotal };
  }

  /**
   * Flush any carried state:
   *   1) Flush the first pass (lowest-level stream buffer).
   *   2) Pipe that tail through each subsequent pass as feed(...) + flush().
   * This mirrors the old fixed pipeline semantics.
   */
  flush(): string {
    if (this.passes.length === 1) {
      return this.passes[0].flush();
    }

    // Start with the first pass's tail
    let tail = this.passes[0].flush();

    // Pipe through the rest of the passes in order
    for (let i = 1; i < this.passes.length; i++) {
      const p = this.passes[i];
      tail = (p.feed(tail).cleaned) + p.flush();
    }

    return tail;
  }

  // Convenience aliases kept for callers/tests that used push/end.
  push(chunk: string): string { return this.feed(chunk).cleaned; }
  end(): string { return this.flush(); }
}

export default LLMNoiseFilter;
