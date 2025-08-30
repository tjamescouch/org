// src/utils/llm-noise-filter.test.ts
import { describe, it, expect } from "bun:test";
import { LLMNoiseFilter } from "../../src/utils/llm-noise-filter";
import { LLMNoiseFilterFirstPass } from "../../src/utils/filter-passes/llm-noise-filter-first-pass"
import { FinalChannelPass } from "../../src/utils/filter-passes/llm-final-channel-pass"
import { AdvancedMemoryScrubPass } from "../../src/utils/filter-passes/llm-adv-memory-scrub-pass"

function collect(filter: LLMNoiseFilter, chunks: string[]): { text: string; removed: number } {
  let text = "";
  let removed = 0;
  for (const c of chunks) {
    const r = filter.feed(c);
    text += r.cleaned;
    removed += r.removed;
  }
  text += filter.flush(); // final drain
  return { text, removed };
}

describe("LLMNoiseFilter – plain text", () => {
  it("returns the chunk as-is and flush() is empty (no duplication)", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const r1 = f.feed("banana");
    expect(r1.cleaned).toBe("banana");
    expect(r1.removed).toBe(0);
    // nothing pending → flush should be empty
    const tail = f.flush();
    expect(tail).toBe("");                  // <- regression guard
  });

  it("does not duplicate across multiple small chunks", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const out = collect(f, ["ban", "ana", "!"]);
    expect(out.text).toBe("banana!");
    expect(out.removed).toBe(0);
  });
});

describe("LLMNoiseFilter – toolformer sentinels", () => {
  const sentinel = `before <|channel|>commentary to=functions sh<|message|>{"cmd":"echo hi"} after`;

  it("removes a complete sentinel with JSON payload in a single chunk", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const out = collect(f, [sentinel]);
    expect(out.text).toBe("before  after");
    expect(out.removed).toBe(1);
  });

  it("removes a sentinel that spans chunk boundaries (no duplication)", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const chunks = [
      "before <|cha",                      // split inside the sentinel
      "nnel|>commentary to=functions sh<|message|>{\"cmd\":1} after",
    ];
    const out = collect(f, chunks);
    expect(out.text).toBe("before  after");
    expect(out.removed).toBe(1);
  });

  it("drops non-JSON sentinel lines up to newline", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const s = `X<|channel|>foo<|message|>not-json-here
Y`;
    const out = collect(f, [s]);
    expect(out.text).toBe("XY");
    expect(out.removed).toBe(1);
  });
});

describe("LLMNoiseFilter – fenced code blocks must be preserved verbatim", () => {
  const code = "```js\nconsole.log('<|channel|>commentary');\n```\nAFTER";
  it("keeps sentinel-like text inside fences", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const out = collect(f, [code]);
    expect(out.text).toBe(code); // unchanged
    expect(out.removed).toBe(0);
  });

  it("handles fences split across chunks without duplicating", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const chunks = ["```", "js\nconsole.log('x')\n```", "\nOK"];
    const out = collect(f, chunks);
    expect(out.text).toBe("```js\nconsole.log('x')\n```\nOK");
    expect(out.removed).toBe(0);
  });
});

describe("LLMNoiseFilter – end-of-stream behavior", () => {
  it("holds incomplete fence as carry during feed, then returns it on flush", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    const r = f.feed("```partial");
    expect(r.cleaned).toBe("");     // not emitted yet
    expect(r.removed).toBe(0);
    // At end of stream we flush whatever was carried
    const tail = f.flush();
    expect(tail).toBe("```partial");
  });

  it("no stray carry for normal text (regression guard for duplication)", () => {
    const f = new LLMNoiseFilter([
      new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
      new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
      new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
    ]);
    f.feed("hello world");
    expect(f.flush()).toBe("");     // nothing to carry in the normal case
  });
});
