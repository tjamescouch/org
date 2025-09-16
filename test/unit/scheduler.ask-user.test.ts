
// test/scheduler.ask-user.test.ts
import { expect, test } from "bun:test";
import { NoiseFilters } from "../../src/scheduler/filters";
import RandomScheduler from "../../src/scheduler/random-scheduler";
import type { ChatMessage } from "../../src/types";
import type { GuardDecision } from "../../src/guardrails/guardrail";
import type { Agent, AgentCallbacks } from "../../src/agents/agent";

class MockAgent implements Agent {
  id: string;
  received: ChatMessage[][] = [];
  saved = false;

  constructor(id: string) { this.id = id; }

  // Minimal surface used by the scheduler
  save() { this.saved = true; }
  guardOnIdle() { return null as any as GuardDecision; }

  async respond(
    messagesIn: ChatMessage[],
    _maxTools: number,
    _filters: NoiseFilters,
    _peers: Agent[],
    callbacks: AgentCallbacks
  ): Promise<string[]> {
    this.received.push(messagesIn);

    // Ask the user once via @@user (triggers onRoute → onRouteCompleted)
    await callbacks.onRoute("@@user please reply: ping", new NoiseFilters());
    await callbacks.onRouteCompleted("ping", 0, true);
    return ["asked"];
  }
}

function makeQueue<T>(items: T[]) {
  let q = [...items];
  return async () => q.length ? q.shift()! : undefined;
}

test("untagged reply DMs last asker (single read via readUserLine)", async () => {
  const a = new MockAgent("alice");

  let askUserCalls: Array<{label: string; prompt: string}> = [];
  const askUser = async (label: string, prompt: string) => {
    askUserCalls.push({ label, prompt });
    // If readUserLine is present, we should NOT be called.
    // Returning empty ensures no accidental consumption.
    return "";
  };

  // First line the user types:
  const readUserLine = makeQueue<string>(["pong"]);

  const sched = new RandomScheduler({
    agents: [a as unknown as Agent],
    maxTools: 10,
    onAskUser: askUser,
    promptEnabled: true,
    idleSleepMs: 1,
    onStreamStart: () => {},
    onStreamEnd: () => {},
    // external bridge provided → scheduler must use this instead of askUser
    readUserLine,
    shuffle: <T>(x: T[]) => x,
  } as any);

  // Seed an initial message so the agent runs
  await (sched as any).interject("hello");   // public API
  const p = sched.start();
  await new Promise(r => setTimeout(r, 30)); // let a tick happen
  sched.stop();
  await p;

  // We should have consumed exactly one line via readUserLine
  expect(askUserCalls.length).toBe(0);

  // And routed the user's "pong" back to the agent exactly once
  const flattened = a.received.flat();
  const got = flattened.find(m => m.role === "user" && m.content.includes("pong"));
  expect(got?.content).toBe("pong");
});

test("explicit @@agent tag overrides default target", async () => {
  const a = new MockAgent("alice");
  const b = new MockAgent("bob");

  const sched = new RandomScheduler({
    agents: [a as any, b as any],
    maxTools: 2,
    onAskUser: async () => "",   // not used
    promptEnabled: true,
    idleSleepMs: 1,
    onStreamStart: () => {},
    onStreamEnd: () => {},
    readUserLine: makeQueue<string>(["@@bob hi bob"]),
    shuffle: <T>(x: T[]) => x,
  } as any);

  await (sched as any).interject("kick");
  const p = sched.start();
  await new Promise(r => setTimeout(r, 30));
  sched.stop(); await p;

  const toBob = b.received.flat().some(m => m.role === "user" && m.content.includes("hi bob"));
  const toAlice = a.received.flat().some(m => m.role === "user" && m.content.includes("hi bob"));
  expect(toBob).toBe(true);
  expect(toAlice).toBe(false);
});

test("group fallback when no default target", async () => {
  const a = new MockAgent("alice");
  const b = new MockAgent("bob");

  const sched = new RandomScheduler({
    agents: [a as any, b as any],
    maxTools: 2,
    onAskUser: async () => "",   // not used
    promptEnabled: true,
    idleSleepMs: 1,
    onStreamStart: () => {},
    onStreamEnd: () => {},
    // no DM tag and no prior asker → broadcast
    readUserLine: makeQueue<string>(["hello all"]),
    shuffle: <T>(x: T[]) => x,
  } as any);

  await (sched as any).interject("init");
  const p = sched.start();
  await new Promise(r => setTimeout(r, 30));
  sched.stop(); await p;

  const gotAlice = a.received.flat().some(m => m.role === "user" && m.content.includes("hello all"));
  const gotBob   = b.received.flat().some(m => m.role === "user" && m.content.includes("hello all"));
  expect(gotAlice && gotBob).toBe(true);
});
