// Runner-agnostic test (works with Jest or Vitest as long as globals are available).
// If your setup requires explicit imports, uncomment the appropriate line below.
// import { describe, it, expect } from "vitest";
// import "@jest/globals";

import { LLMNoiseFilter } from "../llm-noise-filter";

describe("LLMNoiseFilter (streaming)", () => {
  it("filters LLM noise from a streamed chunk sequence and preserves the final message", () => {
    const filter = LLMNoiseFilter.createDefault();

    const input =
      "<|channel|>final <|constrain|>@@user<|message|>Hello! How can I help you today?";

    // Stream one character at a time to exercise boundary handling.
    let collected = "";
    for (const ch of input) {
      collected += filter.push(ch);
    }
    collected += filter.end();

    const expected = "@@user Hello! How can I help you today?";
    expect(collected).toBe(expected);

    // Sanity check: no residual sentinels leaked.
    expect(collected).not.toMatch(/<\|.*?\|>/);
  });
});
