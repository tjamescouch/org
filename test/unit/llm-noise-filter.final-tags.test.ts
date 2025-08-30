import { describe, test, expect } from "bun:test";
import LLMNoiseFilter from "../../src/filters/llm-noise-filter";

describe("LLMNoiseFilter – control tag extraction", () => {
  test("extracts message from <|channel|>final … <|message|> payload", () => {
    const f = new LLMNoiseFilter();

    const input =
      `alice ...\n` +
      `The user says "User: Count with me; I'll start – 1".\n` +
      `<|channel|>final <|constrain|>@user<|message|>Sure, 2.\n` +
      // duplicate final block should not double-print
      `<|channel|>final <|constrain|>@user<|message|>Sure, 2.\n`;

    const out = f.push(input) + f.end();
    expect(out).toBe(
      `alice ...\n` +
      `The user says "User: Count with me; I'll start – 1".\n` +
      `Sure, 2.\n`
    );
  });

  test("handles split tags across chunks (stream-safe)", () => {
    const f = new LLMNoiseFilter();
    const a = `<|channel|>fin`;
    const b = `al <|constrain|>@user<|mes`;
    const c = `sage|>Sure, 2.\nTrail`;
    const d = `ing text`;

    const out = f.push(a) + f.push(b) + f.push(c) + f.push(d) + f.end();
    expect(out).toBe(`Sure, 2.\nTrailing text`);
  });
});
