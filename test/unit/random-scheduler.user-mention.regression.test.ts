import { describe, it, expect } from "bun:test";
import { RandomScheduler } from "../../src/scheduler/random-scheduler";
import type { ChatMessage } from "../../src/types";

type Reply = { message: ChatMessage; toolsUsed: number };
type Responder = {
  id: string;
  respond: (
    msgs: ChatMessage[],
    toolBudget: number,
    peers: string[],
    isDraining: () => boolean
  ) => Promise<Reply[]>;
};

function makeAgent(id: string, replyText: string): Responder {
  return {
    id,
    async respond(msgs) {
      // Reply once with an @@user DM and no tools
      return [{ message: { role: "assistant", from: id, content: `@@user ${replyText}` }, toolsUsed: 0 }];
    },
  };
}

describe("RandomScheduler – @@user regression", () => {
  it("does not reprocess the same prompt after agent replies to @@user", async () => {
    const alice = makeAgent("alice", "hi there");
    const calls: number[] = [];
    const agent: Responder = {
      id: "alice",
      async respond(msgs, budget, peers, isDraining) {
        calls.push(1);
        return [{ message: { role: "assistant", from: "alice", content: "@@user hi" }, toolsUsed: 0 }];
      },
    };

    const scheduler = new RandomScheduler({
      agents: [agent as any],
      maxTools: 0,
      projectDir: process.cwd(),
      onAskUser: async () => "",            // no interactive prompt in test
      promptEnabled: false,                 // avoid idle prompts
      idleSleepMs: 5,
      onStreamStart: () => {},
      onStreamEnd: () => {},
    } as any);

    // seed: user talks to group (goes to alice)
    await scheduler.enqueueUserText("hello everyone");

    // Run the loop briefly, then stop; if it spins, calls[] would keep growing.
    const stopper = setTimeout(() => scheduler.stop(), 50);
    await scheduler.start();
    clearTimeout(stopper);

    // We expect exactly one call to alice.respond(), not an infinite loop.
    expect(calls.length).toBe(1);
  });
});
