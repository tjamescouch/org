import { FinalChannelPass } from "../../filter-passes/llm-final-channel-pass";

const run = (p: FinalChannelPass, s: string) => {
  let out = "";
  for (const ch of s) out += p.feed(ch)?.cleaned ?? "";
  return out + p.flush();
};

test("final channel: drop analysis, unwrap final", () => {
  const p = new FinalChannelPass();
  const input = "<|analysis_start|>secret<|analysis_end|><|final_start|>Hi<|final_end|>";
  expect(run(p, input)).toBe("Hi");
});
