/* bun test test/unit/llm-noise-filter.test.ts */
import { describe, it, expect } from "bun:test";
import { LLMNoiseFilterFirstPass } from "../../src/utils/filter-passes/llm-noise-filter-first-pass";
import { ToolformerSentinelPass } from "../../src/utils/filter-passes/llm-toolformer-sentinel-pass";
import { FinalChannelPass } from "../../src/utils/filter-passes/llm-final-channel-pass";
import LLMNoiseFilter from "../../src/utils/llm-noise-filter";
import { AdvancedMemoryScrubPass } from "../../src/utils/filter-passes/llm-adv-memory-scrub-pass";

type FeedLike = { feed: (s: string) => any; flush: () => string };

function asObj(r: any): { cleaned: string } {
  if (typeof r === "string") return { cleaned: r };
  if (r && typeof r.cleaned === "string") return r as { cleaned: string };
  return { cleaned: String(r ?? "") };
}

export function collect(f: FeedLike, chunks: string[]): string {
  let out = "";
  for (const c of chunks) {
    out += asObj(f.feed(c)).cleaned;
  }
  out += f.flush();
  return out;
}


export function newFilter() {
  const p1: FeedLike = new LLMNoiseFilterFirstPass();
  const p2: FeedLike = new ToolformerSentinelPass();
  const p3: FeedLike = new FinalChannelPass();

  return {
    feed(s: string) {
      const a = asObj(p1.feed(s)).cleaned;
      const b = asObj(p2.feed(a)).cleaned;
      return asObj(p3.feed(b));
    },
    flush() {
      let t = "";
      t += p1.flush();
      t = asObj(p2.feed(t)).cleaned + p2.flush();
      t = asObj(p3.feed(t)).cleaned + p3.flush();
      return t;
    },
  };
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
    expect(out).toBe("banana!");
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
    expect(out).toBe("before  after");
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
    expect(out).toBe("before  after");
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
    expect(out).toBe("XY");
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
    expect(out).toBe(code);
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
    expect(out).toBe("```js\nconsole.log('x')\n```\nOK");
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
