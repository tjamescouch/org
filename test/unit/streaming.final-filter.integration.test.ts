// test/unit/streaming.final-filter.integration.test.ts
import { describe, it, expect } from "bun:test";
import LLMNoiseFilter from "../../src/utils/llm-noise-filter";
import { StreamingTagProtector } from "../../src/utils/tag-protect";

// Helpers — simulate how llm-agent prints streaming tokens when NOT DEBUG.
// (Same pipeline as post-turn, but chunk-by-chunk.)
function streamClean(chunks: string[]): string {
  const filter = LLMNoiseFilter.createDefault();
  const prot = new StreamingTagProtector();
  let out = "";

  for (const ch of chunks) {
    const masked = prot.feedProtect(ch);
    const cleaned = filter.feed(masked).cleaned;
    const unmasked = prot.unprotect(cleaned);
    out += unmasked;
  }

  // Correct flush order: protector → filter → unprotect
  const protTail = prot.flush(); // masked
  const filteredTail = filter.feed(protTail).cleaned + filter.flush();
  const unmaskedTail = prot.unprotect(filteredTail);
  out += unmaskedTail;

  return out;
}

describe("Streaming filter integration", () => {
  it("handles split sentinels across chunks and preserves @@user", () => {
    const chunks = [
      "<|cha",
      "nnel|>fi",
      "nal <|constr",
      "ain|>@@us",
      "er<|mess",
      "age|>Hi! How can I help you today?",
    ];
    const out = streamClean(chunks);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("handles final→json echo across chunk boundaries", () => {
    const chunks = [
      "<|channel|>final <|constrain|>json<|message|>{\"cmd\":\"echo \\\"@@us",
      "er Hi! How can I help you today?\\\"\"}",
    ];
    const out = streamClean(chunks);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("never leaves encoded tags (stream protector encode/decode roundtrip)", () => {
    const prot = new StreamingTagProtector();
    const s1 = prot.feedProtect("@@user Hi");
    const back1 = prot.unprotect(s1);
    expect(back1).toBe("@@user Hi");

    // Also test carry/flush path
    prot.feedProtect("@@us");
    const flushed = prot.flush();         // should contain the encoded fragment
    const round = prot.unprotect(flushed);
    expect(round.includes("@@us") || round.includes("@@user")).toBe(true);
  });

  it("leaves fenced code (stream) untouched", () => {
    const chunks = [
      "before\n```bash\n",
      "<|channel|>final <|constrain|>@@user<|message|>IGNORED in fence\n",
      "```\nafter",
    ];
    const out = streamClean(chunks);
    expect(out).toBe(chunks.join(""));
  });

  it("flush-order regression: trailing final block appears only after flush", () => {
    const chunks = [
      "<|channel|>final <|constrain|>@@user<|message|>Hi!",
      // note: no more chunks -> must rely on flush
    ];
    const out = streamClean(chunks);
    expect(out).toBe("@@user Hi!");
  });
});
