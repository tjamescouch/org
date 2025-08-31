/**
 * Canonical minimal interface for streaming LLM-output filters.
 *
 * A filter is fed incremental chunks of text and may return some cleaned text
 * immediately; anything that could not be decided yet should be kept in the
 * filter's internal carry and only emitted on a later feed() or on flush().
 */
export interface LLMNoiseFilterPass {
  /** Process a streamed chunk and return text that is safe to emit right now. */
  feed(chunk: string): string;

  /** Flush any pending buffered data (called once when the model has stopped). */
  flush(): string;
}
