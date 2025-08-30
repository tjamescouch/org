import { describe, test, expect } from "bun:test";
import LLMNoiseFilter from "../../src/utils/llm-noise-filter";

describe("LLMNoiseFilter – commentary echo unwrapping", () => {
  test("extracts stdout field from commentary JSON", () => {
    const f = new LLMNoiseFilter();
    const input =
      `<|channel|>final <|constrain|>:/commentary<|message|>` +
      `{"ok":true,"stdout":"@@user Just repeat my prompts.\\n","exit_code":0,"cmd":"echo \\"@@user Just repeat my prompts.\\""}\n`;

    const out = f.push(input) + f.end();
    expect(out).toBe(`@@user Just repeat my prompts.\n`);
  });

  test("unwraps echo command when JSON not used", () => {
    const f = new LLMNoiseFilter();
    const input =
      `<|channel|>final <|constrain|>:/commentary<|message|>` +
      `echo '@@user Here is another one.'\n`;
    const out = f.push(input) + f.end();
    expect(out).toBe(`@@user Here is another one.\n`);
  });

  test("leaves content unchanged when nothing matches", () => {
    const f = new LLMNoiseFilter();
    const input = `<|channel|>final <|constrain|>:/commentary<|message|>no-op\n`;
    const out = f.push(input) + f.end();
    expect(out).toBe(`no-op\n`);
  });
});
