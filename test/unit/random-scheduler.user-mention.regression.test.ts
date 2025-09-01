// test/unit/random-scheduler.user-mention.regression.test.ts
import { RandomScheduler } from "../../src/scheduler/random-scheduler";
import type { ChatResponse, Responder } from "../../src/scheduler/types";
import type { ChatMessage } from "../../src/types";

function withDeadline<T>(p: Promise<T>, ms = 1000, label = "deadline"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

class FakeAgent implements Responder {
  constructor(public readonly id: string) {}
  async respond(
    messages: ChatMessage[],
    _toolBudget: number,
    _peers: string[],
  ): Promise<ChatResponse[]> {
    // Produce exactly one reply that begins with '@@user ' like in the regression screenshot.
    if (messages.length === 0) return [];
    return [
      {
        message: {
          role: "assistant",
          from: this.id,
          content: "@@user Hi! How can I help you today?",
        },
        toolsUsed: 0,
      },
    ];
  }
}

describe("Regression: '@@user' mention from assistant should NOT trigger askUser()", () => {
  test("scheduler does not enter ask-user path when agent prefixes '@@user '", async () => {
    const askCalls: Array<{ who: string; prompt: string }> = [];

    const alice = new FakeAgent("alice");
    const scheduler = new RandomScheduler({
      agents: [alice],
      maxTools: 0,
      shuffle: (a) => a,
      projectDir: process.cwd(),
      reviewMode: "skip",
      promptEnabled: true, // if bug exists, this would cause a prompt
      idleSleepMs: 20,
      onAskUser: async (who, prompt) => {
        askCalls.push({ who, prompt });
        return ""; // do not enqueue anything even if called
      },

      // stream deferral hooks (no-ops for the test)
      onStreamStart: () => {},
      onStreamEnd: async () => {},
    } as any);

    const run = scheduler.start();

    // Seed a user message so alice will reply with the '@@user ' line once.
    await scheduler.interject("hello everyone");

    // Allow ≤2 idle ticks (idlePromptEvery=3 in scheduler), then stop to avoid idle prompts.
    await new Promise((r) => setTimeout(r, 60));
    scheduler.stop();

    await withDeadline(run, 1500, "scheduler stop");

    // If the router misinterprets '@@user ' as "ask the human now",
    // onAskUser would have been invoked at least once.
    expect(askCalls.length).toBe(0);
  });
});
