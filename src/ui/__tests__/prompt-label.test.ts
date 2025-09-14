import { describe, test, expect } from "bun:test";
import { formatPromptLabel } from "../../ui/prompt-label";

describe.skip("formatPromptLabel", () => {
  test("defaults to 'You > '", () => {
    expect(formatPromptLabel()).toBe("You > ");
  });

  test("respects username option", () => {
    expect(formatPromptLabel({ username: "alice" })).toBe("alice: ");
  });

  test("respects separator option", () => {
    expect(formatPromptLabel({ username: "bob", separator: " > " })).toBe("bob > ");
  });
});
