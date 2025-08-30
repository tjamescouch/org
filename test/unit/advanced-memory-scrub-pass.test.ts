import { describe, test, expect } from "bun:test";
import { AdvancedMemoryScrubPass } from "../../src/filters/passes/advanced-memory-scrub-pass";

describe("AdvancedMemoryScrubPass", () => {
  test("drops [agent] wrote banner", () => {
    const p = new AdvancedMemoryScrubPass();
    const input = "[alice] wrote. No tools used.\nHello\n";
    expect(p.feed(input) + p.flush()).toBe("Hello\n");
  });

  test("drops agent start block", () => {
    const p = new AdvancedMemoryScrubPass();
    const input = "alice start {\n  promptChars: 1,\n  maxTools: 20,\n}\nNext\n";
    expect(p.feed(input) + p.flush()).toBe("Next\n");
  });

  test("drops 'agent ...' planning banner", () => {
    const p = new AdvancedMemoryScrubPass();
    const input = "alice ...\nUser text\n";
    expect(p.feed(input) + p.flush()).toBe("User text\n");
  });
});
