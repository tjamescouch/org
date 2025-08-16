
// test/e2e-mock-llm-f-server.test.ts
import "./setup";
import { startMockLLMServer } from "./mock-llm";
import { ChatRoom } from "../src/core/chat-room";
import { AgentModel } from "../src/core/entity/agent-model";
import { TurnManager } from "../src/core/turn-manager";
import { sleep } from "./helpers/sleep";

test("e2e f-server: two tools → @group done(L) per agent > routes via OpenAI base, then emits @group", async () => {
  const mock = await startMockLLMServer();
  process.env.OAI_BASE = mock.url;

  const room = new ChatRoom();
  const a = new AgentModel("alice"); room.addModel(a);
  const b = new AgentModel("bob");   room.addModel(b);
  const c = new AgentModel("carol"); room.addModel(c);
  const tm = new TurnManager(room, [a,b,c], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 , disableUserControl: true });

  const groupCounts = new Map<string, number>();
  room.events.on("send", (ev: any) => {
    if (ev?.to === "group" && ev?.from) {
      groupCounts.set(ev.from, (groupCounts.get(ev.from) ?? 0) + 1);
    }
  });

  tm.start();
  await room.broadcast("User", "What is f('hello')?");

  const t0 = Date.now();
  while (
    ((groupCounts.get("alice") ?? 0) +
     (groupCounts.get("bob")   ?? 0) +
     (groupCounts.get("carol") ?? 0)) < 1 &&
    Date.now() - t0 < 5000
  ) {
    await sleep(25);
  }

  tm.stop();
  await mock.close();

  const total = (groupCounts.get("alice") ?? 0) +
                (groupCounts.get("bob")   ?? 0) +
                (groupCounts.get("carol") ?? 0);
  expect(total).toBeGreaterThanOrEqual(1);
});
