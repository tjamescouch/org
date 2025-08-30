/* src/utils/filter-passes/__test__/llm-pda-spacing.test.ts */
import { describe, it, expect } from "bun:test";
import { LLMNoisePDAStream } from "../llm-pda-stream";

const SIZES = [1, 2, 3, 5, 7];

function runAtChunkSize(s: string, n: number): string {
  const f: LLMNoisePDAStream = new LLMNoisePDAStream();
  let out = "";
  for (let i = 0; i < s.length; i += n) {
    out += f.feed(s.slice(i, i + n));
  }
  out += f.flush() ?? "";
  return out;
}

describe("PDA stream filter — mention spacing", () => {
  for (const n of SIZES) {
    it(`normalizes spacing between mention and message (chunk size = ${n})`, () => {
      const s = "<|channel|>final <|constrain|>@@user<|message|>/work";
      expect(runAtChunkSize(s, n)).toBe("@@user /work");
    });
    it(`keeps a single space for a normal sentence (chunk size = ${n})`, () => {
      const s = "<|channel|>final <|constrain|>@@user<|message|>Hello!";
      expect(runAtChunkSize(s, n)).toBe("@@user Hello!");
    });
  }
});
