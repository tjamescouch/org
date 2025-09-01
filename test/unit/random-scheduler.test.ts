// test/unit/random-scheduler.test.ts
import { describe, expect, it, beforeAll } from "bun:test";
import RandomScheduler from "../../src/scheduler/random-scheduler";
import type { ChatMessage } from "../../src/types";
import type { ChatResponse, Responder } from "../../src/scheduler/types";
import { ReviewManager } from "../../src/scheduler/review-manager";

// Make review a no-op for unit tests (avoid I/O and timing noise)
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ReviewManager as any).prototype.finalizeAndReview = async () => {};
});

function makeAgent(id: string, fn: (msgs: ChatMessage[]) => ChatResponse[] | Promise<ChatResponse[]>): Responder {
  return {
    id,
    async respond(messages, _budget, _peers) {
      const msgs = messages as ChatMessage[];
      return await fn(msgs);
    },
  };
}

describe("RandomScheduler — smoke", () => {
  it("broadcasts to both agents and calls respond() once each, then stops", async () => {
    const calls: Record<string, number> = { alice: 0, bob: 0 };

    const mkReply = (from: string, content: string): ChatResponse => ({
      toolsUsed: 0,
      message: { role: "assistant", from, content },
    });

    const alice = makeAgent("alice", (msgs) => {
      calls.alice++;
      // reply with a benign assistant message (no askUser) so we don't block
      return [mkReply("alice", "ack from alice")];
    });

    const bob = makeAgent("bob", (msgs) => {
      calls.bob++;
      return [mkReply("bob", "ack from bob")];
    });

    // Stop after we see two streams (one per agent)
    let streams = 0;
    const scheduler = new RandomScheduler({
      agents: [alice, bob],
      maxTools: 0,
      projectDir: process.cwd(),
      reviewMode: "ask",
      onAskUser: async () => "",   // not used because promptEnabled=false
      promptEnabled: false,        // critical: don't open interactive prompts in unit tests
      idleSleepMs: 5,
      onStreamStart: () => {},
      onStreamEnd: async () => {
        if (++streams >= 2) scheduler.stop();
      },
    });

    // Start, enqueue a group message, and wait for stop
    const p = scheduler.start();
    await scheduler.enqueueUserText("hello everyone");
    await p;

    expect(calls.alice).toBe(1);
    expect(calls.bob).toBe(1);
  });

  it("DM to @@alice routes only to alice; stop after one stream", async () => {
    const calls: Record<string, number> = { alice: 0, bob: 0 };

    const mkReply = (from: string, content: string): ChatResponse => ({
      toolsUsed: 0,
      message: { role: "assistant", from, content },
    });

    const alice = makeAgent("alice", () => {
      calls.alice++;
      return [mkReply("alice", "got it")];
    });
    const bob = makeAgent("bob", () => {
      calls.bob++;
      return []; // should not be called if routing is correct
    });

    let streams = 0;
    const scheduler = new RandomScheduler({
      agents: [alice, bob],
      maxTools: 0,
      projectDir: process.cwd(),
      reviewMode: "ask",
      onAskUser: async () => "",
      promptEnabled: false,
      idleSleepMs: 5,
      onStreamStart: () => {},
      onStreamEnd: async () => {
        if (++streams >= 1) scheduler.stop();
      },
    });

    const p = scheduler.start();
    await scheduler.enqueueUserText("@@alice hi there");
    await p;

    expect(calls.alice).toBe(1);
    expect(calls.bob).toBe(0);
  });
});
