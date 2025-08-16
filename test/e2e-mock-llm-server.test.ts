import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** OpenAI-style chat.completions payload builder */
function buildToolCallsCompletion() {
  const now = Math.floor(Date.now()/1000);
  return {
    id: "cmpl-mock-1",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_one",
            type: "function",
            function: { name: "sh", arguments: JSON.stringify({ cmd: "echo one" }) }
          },
          {
            id: "call_two",
            type: "function",
            function: { name: "sh", arguments: JSON.stringify({ cmd: "echo two" }) }
          }
        ]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  };
}

function buildFinalGroupMessage() {
  const now = Math.floor(Date.now()/1000);
  return {
    id: "cmpl-mock-2",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "@group done" }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
}

/** Minimal stateful OpenAI-ish server */
function startMockLLM(): { port: number, close(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/v1/chat/completions")) {
          const body = await req.json();
          const msgs = Array.isArray(body?.messages) ? body.messages : [];
          const hasToolMsgs = msgs.some((m: any) => m?.role === "tool");

          const payload = hasToolMsgs ? buildFinalGroupMessage() : buildToolCallsCompletion();
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }
  });
  return { port: server.port, close: () => server.stop(true) };
}

/** Override model base URL to hit our mock server */
function overrideModelBaseUrl(m: any, baseUrl: string) {
  m.hasBaseUrlOverride = true;
  m.baseUrlOverride = baseUrl;
}

/** Count @group messages from agents */
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

/** Bun.$ stub that handles both tag and call usage */
function makeBunDollarStub(counter: { count: number }) {
  const fn = (..._args: any[]) => {
    counter.count++;
    return Promise.resolve({
      exitCode: 0, success: true,
      text: async () => "ok\n",
      stdout: new Uint8Array(), stderr: new Uint8Array()
    });
  };
  const tag = (strings: TemplateStringsArray, ..._values: any[]) => {
    counter.count++;
    return Promise.resolve({
      exitCode: 0, success: true,
      text: async () => "ok\n",
      stdout: new Uint8Array(), stderr: new Uint8Array()
    });
  };
  // Proxy so it behaves as both callable function and template tag
  return new Proxy(fn as any, {
    apply(_t, _this, args) { return fn(...args); },
    get(_t, prop) { return (fn as any)[prop] ?? (tag as any)[prop]; }
  });
}

test("e2e: OpenAI API tool_calls → two sh tools then @group", async () => {
  Logger.debug?.("[e2e] starting mock server");
  const server = startMockLLM();
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;

  const room = new ChatRoom();

  const toolCounter = { count: 0 };
  const origBun$: any = (Bun as any).$;
  (Bun as any).$ = makeBunDollarStub(toolCounter);

  try {
    // Three normal models, pointed at the mock LLM
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
      turnTimeoutMs: 2_000
    });

    const groupCounts = wrapGroupCounter(room);

    tm.start();
    await room.broadcast("User", "Kickoff");

    // Wait for 2 tools/agent (total 6) and at least one @group msg per agent
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

    // Pause and ensure no further activity
    const toolsAtPause = toolCounter.count;
    const aAt = groupCounts.get("alice") ?? 0;
    const bAt = groupCounts.get("bob") ?? 0;
    const cAt = groupCounts.get("carol") ?? 0;

    tm.pause();
    await sleep(250);
    expect(toolCounter.count).toBe(toolsAtPause);
    expect(groupCounts.get("alice") ?? 0).toBe(aAt);
    expect(groupCounts.get("bob") ?? 0).toBe(bAt);
    expect(groupCounts.get("carol") ?? 0).toBe(cAt);

    tm.stop();

    // Assertions
    expect(toolCounter.count).toBeGreaterThanOrEqual(wantTools);
    expect(groupCounts.get("alice") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    try { (Bun as any).$ = origBun$; } catch {}
    try { server.close(); } catch {}
  }
}, 20000);
