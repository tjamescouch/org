import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";
import { startToolCallsServer, installFetchProxy } from "./helpers/mock_llm_server";
import { installFetchProxyV2 } from "./helpers/mock_llm_server";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// Bun.$ stub to count tool invocations (both tag and fn styles)
function makeBunDollarStub(counter: { count: number }) {
  const mk = () => ({
    exitCode: 0, success: true,
    text: async () => "ok\n",
    stdout: new Uint8Array(), stderr: new Uint8Array()
  });
  const fn  = (..._args: any[]) => { counter.count++; return Promise.resolve(mk()); };
  const tag = (strings: TemplateStringsArray, ..._vals: any[]) => { counter.count++; return Promise.resolve(mk()); };
  return new Proxy(fn as any, {
    apply(_t, _this, args) { return fn(...args); },
    get(_t, prop) { return (fn as any)[prop] ?? (tag as any)[prop]; }
  });
}

test("e2e: mock LLM always uses 2 tools then returns @group", async () => {
  const server = startToolCallsServer();
  const restoreFetch = installFetchProxyV2(server.port, { verbose: false });

  // Prevent real shell execs; count tool runs
  const toolCounter = { count: 0 };
  const originalBun$: any = (Bun as any).$;
  (Bun as any).$ = makeBunDollarStub(toolCounter);

  const room = new ChatRoom();
  try {
    const alice = new Model("alice") as any;
    const bob   = new Model("bob")   as any;
    const carol = new Model("carol") as any;

    room.addModel(alice);
    room.addModel(bob);
    room.addModel(carol);

    const tm = new TurnManager(room, [alice, bob, carol], {
      tickMs: 20,
      idleBackoffMs: 0,
      proactiveMs: 10_000,
      turnTimeoutMs: 2_000,
    });

    const groupCounts = wrapGroupCounter(room);

    tm.start();
    await room.broadcast("User", "Kickoff");

    // (1) Ensure the mock actually received a request
    const tStart = Date.now();
    while (server.getReqs() < 1 && Date.now() - tStart < 3000) await sleep(25);
    expect(server.getReqs()).toBeGreaterThanOrEqual(1);

    // (2) Wait for tools and group messages (≤10s)
    const wantTools = 2 * 3;
    const t0 = Date.now();
    while (
      (toolCounter.count < wantTools ||
       (groupCounts.get("alice") ?? 0) < 1 ||
       (groupCounts.get("bob") ?? 0)   < 1 ||
       (groupCounts.get("carol") ?? 0) < 1) &&
      Date.now() - t0 < 10_000
    ) {
      await sleep(25);
    }

    // Pause → ensure no further chatter → stop
    const toolsAtPause = toolCounter.count;
    const aAtPause = groupCounts.get("alice") ?? 0;
    const bAtPause = groupCounts.get("bob") ?? 0;
    const cAtPause = groupCounts.get("carol") ?? 0;

    tm.pause();
    await sleep(250);
    expect(toolCounter.count).toBe(toolsAtPause);
    expect(groupCounts.get("alice") ?? 0).toBe(aAtPause);
    expect(groupCounts.get("bob") ?? 0).toBe(bAtPause);
    expect(groupCounts.get("carol") ?? 0).toBe(cAtPause);

    tm.stop();

    // Final assertions
    expect(toolCounter.count).toBeGreaterThanOrEqual(wantTools);
    expect(groupCounts.get("alice") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    try { (Bun as any).$ = originalBun$; } catch {}
    try { restoreFetch(); } catch {}
    try { server.close(); } catch {}
  }
}, 20000);
