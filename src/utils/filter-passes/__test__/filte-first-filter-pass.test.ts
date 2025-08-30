import { LLMNoiseFilterFirstPass } from "../llm-noise-filter-first-pass";
import type { LLMNoiseFilterPass } from "../llm-noise-filter-pass";

const stream = (p: LLMNoiseFilterPass, s: string) => {
  let out = "";
  for (const ch of s) out += p.feed(ch)?.cleaned ?? "";
  return out + p.flush();
};

test("first pass: channel+message with interspersed fence", () => {
  const p = new LLMNoiseFilterFirstPass();
  const input = "<|channel|>final <|constrain|>@@user<|message|>Hello!";
  expect(stream(p, input)).toBe("@@user Hello!");
});

test("first pass: preserves tokens inside generic fence", () => {
  const p = new LLMNoiseFilterFirstPass();
  const input = "before\n```bash\n<|constrain|>\n```\nafter";
  expect(stream(p, input)).toBe("before\n```bash\n<|constrain|>\n```\nafter");
});
