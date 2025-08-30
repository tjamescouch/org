export type PassFeedResult = { cleaned: string; removed?: number };

export interface LLMNoiseFilterPass {
  /** Feed a (possibly partial) chunk through the pass. */
  feed(chunk: string): PassFeedResult;

  /** Flush any carried state from this pass (e.g., incomplete fences/tags). */
  flush(): string;
}
