import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";
import { startFServer } from "./helpers/mock_llm_server";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function wrapGroupCounter(room: any) {
  const orig = room.broadcast?.bind(room);
  const counts = new Map<string, number>();
  room.broadcast = async (from: string, content: any, to?: string) => {
    if ((!to || to === "@group") && from !== "User") {
      counts.set(from, (counts.get(from) || 0) + 1);
    }
    return orig(from, content, to);
  };
  return counts;
}

function makeBunDollarStub() {
  const mk = () => ({
    exitCode: 0, success: true,
    text: async () => "ok\n",
    stdout: new Uint8Array(), stderr: new Uint8Array()
  });
  const fn  = (..._args: any[]) => Promise.resolve(mk());
  const tag = (strings: TemplateStringsArray, ..._vals: any[]) => Promise.resolve(mk());
  return new Proxy(fn as any, {
    apply(_t, _this, args) { return fn(...args); },
    get(_t, prop) { return (fn as any)[prop] ?? (tag as any)[prop]; }
  });
}

test("e2e f-server: two tools → @group done(h8) per agent", async () => {
  const mock = startFServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  // Force client to use our server
  const prevEnv = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ORG_OPENAI_BASE_URL: process.env.ORG_OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.ORG_OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = "sk-test";

  // Prevent real shell execs
  const origBun$: any = (Bun as any).$;
  (Bun as any).$ = makeBunDollarStub();

  const room = new ChatRoom();
  try {
    const alice = new Model("alice") as any;
    const bob   = new Model("bob")   as any;
    const carol = new Model("carol") as any;

    room.addModel(alice);
    room.addModel(bob);
    room.addModel(carol);

    const tm = new TurnManager(room, [alice, bob, carol], {
      tickMs: 20, idleBackoffMs: 0, proactiveMs: 10_000, turnTimeoutMs: 2_000
    });

    const groupCounts = wrapGroupCounter(room);

    tm.start();
    await room.broadcast("User", "What is f('hello')?");

    // Ensure server is actually hit
    const tStart = Date.now();
    while (mock.getReqs() < 1 && Date.now() - tStart < 2000) await sleep(25);
    expect(mock.getReqs()).toBeGreaterThanOrEqual(1);

    // Wait until we see requests with tool messages for each agent
    const wantAgents = 3;
    const t0 = Date.now();
    while (
      (mock.getToolReqs() < wantAgents ||
       (groupCounts.get("alice") ?? 0) < 1 ||
       (groupCounts.get("bob") ?? 0)   < 1 ||
       (groupCounts.get("carol") ?? 0) < 1) &&
      Date.now() - t0 < 10_000
    ) {
      await sleep(25);
    }

    // Pause → ensure no further churn → stop
    const toolReqsAt = mock.getToolReqs();
    const aAt = groupCounts.get("alice") ?? 0;
    const bAt = groupCounts.get("bob") ?? 0;
    const cAt = groupCounts.get("carol") ?? 0;

    tm.pause();
    await sleep(250);
    expect(mock.getToolReqs()).toBe(toolReqsAt);
    expect(groupCounts.get("alice") ?? 0).toBe(aAt);
    expect(groupCounts.get("bob") ?? 0).toBe(bAt);
    expect(groupCounts.get("carol") ?? 0).toBe(cAt);

    tm.stop();

    // Final assertions
    expect(mock.getToolReqs()).toBeGreaterThanOrEqual(wantAgents);
    expect(groupCounts.get("alice") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    try { (Bun as any).$ = origBun$; } catch {}
    process.env.OPENAI_BASE_URL  = prevEnv.OPENAI_BASE_URL;
    process.env.ORG_OPENAI_BASE_URL = prevEnv.ORG_OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY   = prevEnv.OPENAI_API_KEY;
    try { mock.close(); } catch {}
  }
}, 20000);
