/* bun test test/unit/llm-noise-filter.final-and-json.test.ts */
import { describe, it, expect } from "bun:test";
import { LLMNoiseFilterFirstPass } from "../../src/utils/filter-passes/llm-noise-filter-first-pass";
import { ToolformerSentinelPass } from "../../src/utils/filter-passes/llm-toolformer-sentinel-pass";
import { FinalChannelPass } from "../../src/utils/filter-passes/llm-final-channel-pass";

type FeedLike = { feed: (s: string) => any; flush: () => string };

function asObj(r: any): { cleaned: string } {
  if (!r) return { cleaned: "" };
  if (typeof r === "string") return { cleaned: r };
  if (typeof r.cleaned === "string") return r as { cleaned: string };
  return { cleaned: String(r) };
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

function postTurnClean(s: string): string {
  const f = newFilter();
  const out = f.feed(s).cleaned + f.flush();
  return out;
}

describe("LLMNoiseFilter — final channel & JSON/commentary", () => {
  it("strips <|channel|>final … <|message|> and preserves @@user tag", () => {
    const s = "<|channel|>final <|message|>@@user Hi! How can I help you today?";
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi! How can I help you today?");
  });

  it("unwraps final|json with echo command (double quotes)", () => {
    const s = `<|channel|>final|json<|message|>{"cmd":"echo \\"@@user Hi!\\" "}`;
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi!");
  });

  it("unwraps final|json with echo command (single quotes)", () => {
    const s = `<|channel|>final|json<|message|>{"cmd":"echo '@@user Hi!'"}`;
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi!");
  });

  it("unwraps commentary JSON stdout field", () => {
    const s = `<|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Hi!"}`;
    const out = postTurnClean(s);
    expect(out).toBe("@@user Hi!");
  });

  it("preserves fenced blocks verbatim (no filtering inside ```)", () => {
    const s = "before\n```sh\n<|channel|>final <|message|>@@user nope\n```\nafter";
    const out = postTurnClean(s);
    expect(out).toBe("before\n```sh\n<|channel|>final <|message|>@@user nope\n```\nafter");
  });

  it("final channel unwrapping > preserves @@user tag when surrounded", () => {
    const s = "before\n<|channel|>final <|message|>@@user should NOT be unwrapped here\n\nafter";
    const out = postTurnClean(s);
    expect(out).toBe("before\n@@user should NOT be unwrapped here\n\nafter");
  });
});
