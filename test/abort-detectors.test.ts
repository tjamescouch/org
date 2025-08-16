import { describe, test, expect } from "bun:test";
import {
  sanitizeAssistantText,
  MetaTagLeakDetector,
  AgentQuoteAbortDetector,
  ToolEchoFloodDetector,
  RepetitionAbortDetector,
  CrossTurnRepetitionDetector,
  MaxLengthAbortDetector,
  SpiralPhraseDetector,
} from "../src/core/abort-detectors";

describe("abort-detectors & sanitizer", () => {
  test("sanitizeAssistantText trims meta/control tags", () => {
    const { text, aborted } = sanitizeAssistantText(
      "Hello<|im_start|>system hidden"
    );
    expect(aborted).toBe(true);
    expect(text).toBe("Hello");
  });

  test("MetaTagLeakDetector catches tags", () => {
    const det = new MetaTagLeakDetector();
    const res = det.check("foo <|assistant|> bar");
    expect(!!res).toBe(true);
  });

  test("AgentQuoteAbortDetector catches agent name prefixes", () => {
    const det = new AgentQuoteAbortDetector(["alice", "bob"]);
    const res = det.check("Hi\nAlice: hello", { agents: ["alice", "bob"] });
    expect(!!res).toBe(true);
  });

  test("ToolEchoFloodDetector limits repeated tool_calls echoes", () => {
    const det = new ToolEchoFloodDetector(2);
    const s =
      '{"tool_calls":[1]}\n' +
      '{"tool_calls":[2]}\n' +
      '{"tool_calls":[3]}';
    const res = det.check(s);
    expect(!!res).toBe(true);
  });

  test("RepetitionAbortDetector flags repeated tail phrase", () => {
    const det = new RepetitionAbortDetector({ tailWords: 3, maxRepeats: 2, minWordsForNovelty: 99999, minNoveltyRatio: 0.0 });
    const s = "one two three one two three one two three";
    const res = det.check(s);
    expect(!!res).toBe(true);
  });

  test("CrossTurnRepetitionDetector notices overlap with SoC", () => {
    const det = new CrossTurnRepetitionDetector({ tailWords: 3, minChars: 10, minNoveltyRatio: 0.0, sampleSocChars: 1000 });
    const res = det.check("alpha beta gamma", { soc: "zzz alpha beta gamma yyy" });
    expect(!!res).toBe(true);
  });

  test("MaxLengthAbortDetector truncates overly long content", () => {
    const det = new MaxLengthAbortDetector(10);
    const res = det.check("0123456789abcdef");
    expect(!!res).toBe(true);
  });

  test("SpiralPhraseDetector finds telltale phrases", () => {
    const det = new SpiralPhraseDetector();
    const res = det.check("We need to run ls -R");
    expect(!!res).toBe(true);
  });
});

