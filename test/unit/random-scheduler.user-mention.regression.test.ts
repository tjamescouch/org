// test/unit/random-scheduler.user-mention.regression.test.ts
import { describe, it, expect } from "bun:test";
import { FakeAgent, runSchedulerUntil } from "../_helpers/fake-agent";
import type { ChatMessage } from "../../src/types";

const byLastUser = (t: string) => (msgs: ChatMessage[]) =>
  (msgs[msgs.length - 1]?.role === "user") &&
  msgs[msgs.length - 1].content.toLowerCase().includes(t.toLowerCase());

describe("RandomScheduler – @@user regression", () => {
  it("agent greets user using @@user and does not DM itself", async () => {
    const alice = new FakeAgent("alice", [
      {
        when: byLastUser("hi"),
        reply: { kind: "mentionUser", text: "Hi! How can I help you today?" },
      },
    ]);

    const probe = await runSchedulerUntil({
      agents: [alice],
      interject: "hi",
      promptEnabled: false,
      deadlineMs: 1000,
      expect: () => alice.sent.some(m => m.content.startsWith("@@user")),
    });

    // The message we wanted:
    const m = alice.sent.find(x => x.content.startsWith("@@user"));
    expect(m).toBeDefined();
    expect(m!.content).toMatch(/@@user/i);

    // And crucially, it did NOT DM itself:
    const wrong = alice.sent.find(x => x.content.startsWith("@@alice"));
    expect(wrong).toBeUndefined();

    // Sanity: scheduler did not need to ask the user here.
    expect(probe.asks.length).toBe(0);
  });
});
