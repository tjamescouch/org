// test/_helpers/fake-agent.ts
import type { ChatMessage } from "../../src/types";
import type { ChatResponse, Responder } from "../../src/scheduler/types";
import { RandomScheduler } from "../../src/scheduler/random-scheduler";
import { Logger } from "../../src/logger";

type FakeReply =
  | { kind: "say"; text: string; tools?: number }
  | { kind: "dm"; to: string; text: string; tools?: number }
  | { kind: "mentionUser"; text: string; tools?: number }
  | { kind: "askUser"; prompt: string; tools?: number };

type FakeRule = {
  when: (history: ChatMessage[]) => boolean;
  reply: FakeReply | FakeReply[];
};

export class FakeAgent implements Responder {
  readonly id: string;
  private readonly rules: FakeRule[];
  /** for assertions/debug */
  public readonly seen: ChatMessage[] = [];
  public readonly sent: ChatMessage[] = [];

  constructor(id: string, rules: FakeRule[]) {
    this.id = id;
    this.rules = rules;
  }

  async respond(
    messages: ChatMessage[],
    _budget: number,
    _peers: string[],
    _shouldStop: () => boolean,
  ): Promise<ChatResponse[]> {
    this.seen.push(...messages);

    const rule = this.rules.find(r => r.when(messages));
    if (!rule) return [];

    const replies = Array.isArray(rule.reply) ? rule.reply : [rule.reply];
    const out: ChatResponse[] = [];

    for (const r of replies) {
      let content = "";
      switch (r.kind) {
        case "say":
          content = r.text;
          break;
        case "dm":
          // DM to another agent via router’s tag splitter
          content = `@@${r.to} ${r.text}`;
          break;
        case "mentionUser":
          // the regression we care about: replying to the user
          content = `@@user ${r.text}`;
          break;
        case "askUser":
          // ask-user turn – router should surface askedUser=true
          content = `@@user ${r.prompt}`;
          break;
      }
      const msg: ChatMessage = { role: "assistant", from: this.id, content };
      this.sent.push(msg);
      out.push({ message: msg, toolsUsed: r.tools ?? 0 });
    }

    return out;
  }

  // (Optional) let tests add rules on the fly
  addRule(rule: FakeRule) { this.rules.push(rule); }
}

/** Small probe of what the scheduler is doing (for assertions). */
type Probe = {
  asks: Array<{ from: string; prompt: string }>;
  logs: string[];
};

type RunOptions = {
  agents: Responder[];
  promptEnabled?: boolean;
  idleSleepMs?: number;
  maxTools?: number;
  projectDir?: string;
  userLines?: string[]; // provided to onAskUser or readUserLine (idle)
  interject?: string;   // initial user text to enqueue
  deadlineMs?: number;
  expect?: (probe: Probe) => boolean; // stop when this returns true
};

/**
 * Start the scheduler and resolve when `expect(probe)` returns true,
 * or reject on deadline. Always stops the scheduler.
 */
export async function runSchedulerUntil(opts: RunOptions): Promise<Probe> {
  const probe: Probe = { asks: [], logs: [] };

  const lines = [...(opts.userLines ?? [])];
  const askUser = async (from: string, prompt: string) => {
    probe.asks.push({ from, prompt });
    return lines.shift(); // undefined => empty submit
  };

  const scheduler = new RandomScheduler({
    agents: opts.agents,
    maxTools: opts.maxTools ?? 2,
    onAskUser: askUser,
    promptEnabled: opts.promptEnabled ?? false,
    idleSleepMs: opts.idleSleepMs ?? 5,
    projectDir: opts.projectDir ?? process.cwd(),
    onStreamStart: () => {},
    onStreamEnd: async () => {},
    // external idle prompt bridge (optional)
    readUserLine: async () => lines.shift(),
    shuffle: <T>(a: T[]) => a, // deterministic order in tests
  });

  // start loop (don’t await)
  const startP = scheduler.start();

  const deadline = Date.now() + (opts.deadlineMs ?? 1500);
  const stopAndWait = async () => {
    scheduler.stop();
    try { await startP; } catch { /* swallow */ }
  };

  // seed an initial user message if requested
  if (opts.interject) await scheduler.interject(opts.interject);

  // poll until predicate says we’re done, or we hit the deadline
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.expect?.(probe)) break;
      if (Date.now() > deadline) {
        throw new Error("deadline");
      }
      await new Promise(r => setTimeout(r, 10));
    }
  } catch (e) {
    await stopAndWait();
    throw e;
  }

  await stopAndWait();
  return probe;
}
