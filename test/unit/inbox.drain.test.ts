import { describe, it, expect } from "bun:test";
import Inbox from "../../src/scheduler/inbox";
import type { ChatMessage } from "../../src/types";

describe("Inbox", () => {
  it("nextPromptFor drains the queue", () => {
    const inbox = new Inbox();
    const id = "alice";
    const msgs: ChatMessage[] = [
      { role: "user", from: "User", content: "one" },
      { role: "user", from: "User", content: "two" },
    ];
    for (const m of msgs) inbox.push(id, m);

    expect(inbox.size(id)).toBe(2);

    const drained = inbox.nextPromptFor(id);
    expect(drained.map(m => m.content)).toEqual(["one", "two"]);

    // Queue must now be empty
    expect(inbox.size(id)).toBe(0);
    // Draining again should give []
    expect(inbox.nextPromptFor(id)).toEqual([]);
  });
});
