import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";
import { Model } from "../src/core/entity/model";

// --- tiny LLM mock server ----------------------------------------------------

function buildCompletion(): any {
  const now = Math.floor(Date.now() / 1000);
  const content =
    "```tool\n" +
    JSON.stringify({ name: "sh", input: "echo one" }) + "\n" +
    "```\n" +
    "```tool\n" +
    JSON.stringify({ name: "sh", input: "echo two" }) + "\n" +
    "```\n" +
    "@group done";

  // Return a plain Chat Completions JSON. Client code can use the textual content,
  // and we also include a tool_calls-looking structure for good measure.
  return {
    id: "cmpl-mock-1",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content,
        tool_calls: [
          { type: "function", function: { name: "sh", arguments: "{\"cmd\":\"echo one\"}" } },
          { type: "function", function: { name: "sh", arguments: "{\"cmd\":\"echo two\"}" } }
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function startMockLLM(): { port: number, close(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST") {
        return new Response(JSON.stringify(buildCompletion()), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok");
    },
  });
  return {
    port: server.port,
    close: () => server.stop(true),
  };
}

// --- helpers -----------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function overrideModelBaseUrl(m: any, baseUrl: string) {
  // Follows the pattern seen in your logs: hasBaseUrlOverride + baseUrlOverride.
  m.hasBaseUrlOverride = true;
  m.baseUrlOverride = baseUrl;
}

function wrapGroupCounter(room: any) {
  const orig = room.broadcast?.bind(room);
  const counts = new Map<string, number>();
  room.broadcast = async (from: string, content: any, to?: string) => {
    if (!to || to === "@group") {
      if (from !== "User") {
        counts.set(from, (counts.get(from) || 0) + 1);
      }
    }
    return orig(from, content, to);
  };
  return counts;
}

// --- the actual e2e test -----------------------------------------------------

test("e2e: mock LLM always uses 2 tools then returns @group", async () => {
  // 1) Start the mock LLM server
  const server = startMockLLM();
  const baseUrl = `http://127.0.0.1:${server.port}`;

  // 2) Set up room, agents, scheduler
  const room = new ChatRoom();
  const shCounter = { count: 0 };

  // Stub Bun.$ as a template-literal tag to count `sh` tool invocations.
  const originalBun$: any = (Bun as any).$;
  (Bun as any).$ = (strings: TemplateStringsArray, ...values: any[]) => {
    // Reconstruct command string (best effort)
    let cmd = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) cmd += String(values[i]) + (strings[i + 1] ?? "");
    shCounter.count++;
    // Return a minimal, awaitable object used by typical code paths
    return Promise.resolve({
      exitCode: 0,
      success: true,
      text: async () => "ok\n",
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
  };

  try {
    // Three agents, all hitting the mock LLM server
    const alice = new Model("alice") as any;
    const bob   = new Model("bob") as any;
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

    // 3) Wait for 2 tools per agent (total 6) and at least one @group message per agent
    const wantTools = 2 * 3; // 2 per agent * 3 agents
    const t0 = Date.now();
    while (
      (shCounter.count < wantTools ||
       (groupCounts.get("alice") ?? 0) < 1 ||
       (groupCounts.get("bob") ?? 0)   < 1 ||
       (groupCounts.get("carol") ?? 0) < 1) &&
      Date.now() - t0 < 6000
    ) {
      await sleep(25);
    }

    // 4) Pause then ensure no further chatter, then stop
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

    // 5) Assertions: we saw 2 tools per agent and a group message per agent
    expect(shCounter.count).toBeGreaterThanOrEqual(wantTools);
    expect(groupCounts.get("alice") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThanOrEqual(1);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    // Cleanup
    try { (Bun as any).$ = originalBun$; } catch {}
    try { server.close(); } catch {}
  }
}, 15000);
