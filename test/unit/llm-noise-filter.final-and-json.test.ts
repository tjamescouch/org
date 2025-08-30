// test/unit/llm-noise-filter.final-and-json.test.ts
import { describe, it, expect } from "bun:test";
import LLMNoiseFilter from "../../src/utils/llm-noise-filter";
import { protectWhole, unprotectWhole } from "../../src/utils/tag-protect";

// Helpers – mirror the post-turn cleaning path the scheduler uses.
function postTurnClean(input: string): string {
  const f = LLMNoiseFilter.createDefault();
  const masked = protectWhole(String(input ?? ""));
  const cleaned = f.feed(masked).cleaned + f.flush();
  return unprotectWhole(cleaned);
}

describe("LLMNoiseFilter — final channel unwrapping", () => {
  it("strips <|channel|>final ... <|message|> and preserves @@user tag", () => {
    const s =
      "<|channel|>final <|constrain|>@@user<|message|>Hi! How can I help you today?";
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("unwraps final→json with echo command (double quotes)", () => {
    const s =
      '<|channel|>final <|constrain|>json<|message|>{"cmd":"echo \\"@@user Hi! How can I help you today?\\""}';
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("unwraps final→json with echo command (single quotes)", () => {
    const s =
      "<|channel|>final <|constrain|>json<|message|>{\"cmd\":\"echo '@@user Hi! How can I help you today?'\"}";
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("unwraps final→commentary JSON stdout field", () => {
    const s =
      '<|channel|>final <|constrain|>/commentary<|message|>{"ok":true,"stdout":"@@user Hi! How can I help you today?"}';
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("preserves fenced blocks verbatim (no filtering inside ```)", () => {
    const s =
      "before\n```ts\n<|channel|>final <|constrain|>@@user<|message|>should NOT be unwrapped here\n```\nafter";
    const out = postTurnClean(s);
    expect(out).toBe(s);
  });
});
