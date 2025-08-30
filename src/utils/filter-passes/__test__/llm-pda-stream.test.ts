import { describe, it, expect } from "bun:test";
import { LLMNoisePDAStream } from "../llm-pda-stream";

const SIZES = [1, 2, 3, 5, 7];

function runAtChunkSize(s: string, n: number): string {
  const f = new LLMNoisePDAStream();
  let r = "";
  for (let i = 0; i < s.length; i += n) {
    const chunk = s.slice(i, i + n);
    r += f.feed(chunk);
  }
  return r + f.flush();
}

describe("PDA stream filter — streaming (parameterized)", () => {
  for (const n of SIZES) {
    it(`final channel: interspersed fence + mention (chunk size = ${n})`, () => {
      const s = "<|channel|>final <|constrain|>@@user<|message|>Hello!";
      expect(runAtChunkSize(s, n)).toBe("@@user Hello!");
    });

    it(`fence preserved verbatim (chunk size = ${n})`, () => {
      const s =
        "A\n```ts\n<|analysis_start|>keep this literal<|analysis_end|>\n```\nB";
      expect(runAtChunkSize(s, n)).toBe(s);
    });

    it(`drop memory + analysis + tool_call, unwrap tool_result (chunk size = ${n})`, () => {
      const s =
        "A<|memory_start|>DUMP<|memory_end|>B" +
        "<|analysis_start|>secret<|analysis_end|>" +
        "<|tool_call_start|>{...}<|tool_call_end|>" +
        "<|tool_result_start|>OK<|tool_result_end|>C";
      expect(runAtChunkSize(s, n)).toBe("ABOKC");
    });

    it(`final|json → echo unwrap (chunk size = ${n})`, () => {
      const s = `<|channel|>final |json<|message|>{"cmd":"echo \\"@@user Hi!\\" "}`;
      expect(runAtChunkSize(s, n)).toBe("@@user Hi!");
    });

    it(`commentary JSON → stdout (chunk size = ${n})`, () => {
      const s = `<|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Done."}`;
      expect(runAtChunkSize(s, n)).toBe("@@user Done.");
    });

    it(`toolformer commentary to=functions sh line is dropped (chunk size = ${n})`, () => {
      const s = `before <|channel|>commentary to=functions sh<|message|>{"cmd":1} after`;
      expect(runAtChunkSize(s, n)).toBe("before  after");
    });

    it(`drop non-JSON channel line up to newline (chunk size = ${n})`, () => {
      const s = "X<|channel|>foo<|message|>not-json-here\nY";
      expect(runAtChunkSize(s, n)).toBe("XY");
    });

    it(`unwrap <|final_start|>…<|final_end|> (chunk size = ${n})`, () => {
      const s = "before<|final_start|>OK<|final_end|>after";
      expect(runAtChunkSize(s, n)).toBe("beforeOKafter");
    });
  }
});
