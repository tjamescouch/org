import { describe, test, expect } from "bun:test";
import { formatPromptLabel } from "../../ui/prompt-label";

describe("formatPromptLabel", () => {
  test("defaults to 'user: '", () => {
    expect(formatPromptLabel()).toBe("user: ");
  });

  test("respects username option", () => {
    expect(formatPromptLabel({ username: "alice" })).toBe("alice: ");
  });

  test("respects separator option", () => {
    expect(formatPromptLabel({ username: "bob", separator: " > " })).toBe("bob > ");
  });
});
