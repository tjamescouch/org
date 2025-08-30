import { AdvancedMemoryScrubPass } from "../../filter-passes/llm-adv-memory-scrub-pass";

const go = (p: AdvancedMemoryScrubPass, s: string) => {
  let out = "";
  for (const ch of s) out += p.feed(ch)?.cleaned ?? "";
  return out + p.flush();
};

test("memory scrub: drop memory blocks; keep bash fence", () => {
  const p = new AdvancedMemoryScrubPass();
  const input = "A<|memory_start|>dump<|memory_end|>B\n```bash\nBEGIN MEMORY\n```\nC";
  expect(go(p, input)).toBe("AB\n```bash\nBEGIN MEMORY\n```\nC");
});
