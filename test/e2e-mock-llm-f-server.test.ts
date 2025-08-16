import { describe, it, expect } from "bun:test";
import { startSimpleLLMServer } from "./utils/simple_llm_server";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

describe("e2e f-server: two tools → @group done(L) per agent", () => {
  it("routes via OpenAI base, then emits @group", async () => {
    const mock = await startSimpleLLMServer();
    process.env.OAI_BASE = mock.url;
    process.env.OPENAI_COMPAT = "1";
    process.env.FORCE_V1 = "1";

    const { ChatRoom } = await import("../src/core/chat-room");
    const { AgentModel } = await import("../src/core/entity/agent-model");
    const { TurnManager } = await import("../src/core/turn-manager");

    const room = new ChatRoom();
    const a = new AgentModel("alice"); room.addModel(a);
    const b = new AgentModel("bob");   room.addModel(b);
    const c = new AgentModel("carol"); room.addModel(c);
    const tm = new TurnManager(room, [a,b,c], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });

    const groupCounts = new Map<string, number>();
    room.events.on("send", (ev: any) => {
      if (ev.to === "@group" || ev.to === "group") {
        groupCounts.set(ev.from, (groupCounts.get(ev.from) ?? 0) + 1);
      }
    });

    tm.start();
    await room.broadcast("User", "What is f('hello')?");

    const t0 = Date.now();
    while (mock.getReqs() < 1 && Date.now() - t0 < 3000) await sleep(25);
    expect(mock.getReqs()).toBeGreaterThanOrEqual(1);

    await sleep(500);
    tm.stop();

    expect(groupCounts.get("alice") ?? 0).toBeGreaterThan(0);
    expect(groupCounts.get("bob") ?? 0).toBeGreaterThan(0);
    expect(groupCounts.get("carol") ?? 0).toBeGreaterThan(0);

    await mock.close();
  });
});
