import { ToolformerSentinelPass } from "../llm-toolformer-sentinel-pass";

const pump = (p: ToolformerSentinelPass, s: string) => {
  let out = "";
  for (const ch of s) out += p.feed(ch)?.cleaned ?? "";
  return out + p.flush();
};

test("toolformer: drops tool_call block, unwraps tool_result", () => {
  const p = new ToolformerSentinelPass();
  const input =
    "<|tool_call_start|>{...}<|tool_call_end|>" +
    "<|tool_result_start|>OK<|tool_result_end|>";
  expect(pump(p, input)).toBe("OK");
});
