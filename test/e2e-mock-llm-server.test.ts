// test/e2e-mock-llm-server.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";
import { Model } from "../src/core/entity/model";
import { startToolCallsServer } from "./helpers/mock_llm_server";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function overrideModelBaseUrl(m: any, baseUrl: string) {
  m.hasBaseUrlOverride = true;
  m.baseUrlOverride = baseUrl;
}

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

// Bun.$ stub to count tools (tag + fn styles)
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
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const room = new ChatRoom();

  const shCounter = { count: 0 };
  const originalBun$: any = (Bun as any).$;
  (Bun as any).$ = makeBunDollarStub(shCounter);

  try {
    const alice = new Model("alice") as any;
    const bob   = new Model("bob")   as any;
    const carol = new Model("carol") as any;

    overrideModelBaseUrl(alice, baseUrl);
    overrideModelBaseUrl(bob,   baseUrl);
    overrideModelBaseUrl(carol, baseUrl);

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

    // Ensure server is actually hit
    const wantTools = 2 * 3;
    const t0 = Date.now();
    while (
      (shCounter.count < wantTools ||
       (groupCounts.get("alice") ?? 0) < 1 ||
       (groupCounts.get("bob") ?? 0)   < 1 ||
       (groupCounts.get("carol") ?? 0) < 1) &&
      Date.now() - t0 < 8000
    ) {
      await sleep(25);
    }

    const toolsAtPause = shCounter.count;
    const aAtPause = groupCounts.get("alice") ?? 0;
    const bAtPause = groupCounts.get("bob") ?? 0;
    const cAtPause = groupCounts.get("carol") ?? 0;

    tm.pause();
    await sleep(250);
    expect(shCounter.count).toBe(toolsAtPause);
    expect(groupCounts.get("alice") ?? 0).toBe(aAtPause);
    expect(groupCounts.get("bob") ?? 0).toBe(bAtPause);
    expect(groupCounts.get("carol") ?? 0).toBe(cAtPause);

    tm.stop();

    expect(shCounter.count).toBeGreaterThanOrEqual(wantTools);
    expect(groupCounts.get("alice") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    try { (Bun as any).$ = originalBun$; } catch {}
    try { server.close(); } catch {}
  }
}, 20000);
