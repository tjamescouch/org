import { decidePostAssistantAction } from "../../src/scheduler/post-assistant-decision";

describe("post-assistant routing/yield decision", () => {
  it("yields to the user when a top-level @@user tag is present", () => {
    const txt = [
      "Thanks! Here's the plan.",
      "@@user Let me know what you’d like me to do next.",
    ].join("\n");

    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(true);
    expect(d.continueWith ?? null).toBeNull();
  });

  it("treats @@group like a user-facing handoff", () => {
    const txt = [
      "Summary for everyone:",
      "@@group We’re ready to proceed with the patch.",
    ].join("\n");

    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(true);
    expect(d.continueWith ?? null).toBeNull();
  });

  it("ignores tags inside fenced code blocks", () => {
    const txt = [
      "Here is an example:",
      "```",
      "@@user this is inside a code fence and should NOT trigger yield",
      "```",
      "That’s all.",
    ].join("\n");

    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(false);
    expect(d.continueWith ?? null).toBeNull();
  });

  it("suggests continuing to another agent when no @@user is present", () => {
    const txt = [
      "Routing to a specialist:",
      "@@bob Please review the diff hunk and comment.",
    ].join("\n");

    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(false);
    expect(d.continueWith).toBe("bob");
  });

  it("is robust to whitespace and mixed casing", () => {
    const txt = ["  @@UsEr  ping", "done"].join("\n");
    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(true);
  });

  it("does nothing when there are no top-level tags", () => {
    const txt = "plain text only";
    const d = decidePostAssistantAction(txt);
    expect(d.yieldToUser).toBe(false);
    expect(d.continueWith ?? null).toBeNull();
  });
});
