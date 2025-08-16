import ChatRoom from "../src/core/chat-room";
import AgentModel from "../src/core/entity/agent-model";
import { TurnManager } from "../src/core/turn-manager";
import { startMockLLMServer } from "./mock-llm";
// re-usable mock(s)

const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));

// Simple helper: spin until predicate or timeout
async function waitUntil(pred: () => boolean, timeoutMs=4000, stepMs=25) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < timeoutMs) await sleep(stepMs);
}

/**
 * f-server variant: LLM answers f(question) after two tools. We assert tool path + deliveries.
 */
test("routes via OpenAI base, then emits @group", async () => {
  const mock = await startMockLLMServer({ mode: "f" });
  const baseUrl = mock.baseUrl;

  const room = new ChatRoom();
  const a = new AgentModel("alice", { baseUrl });
  const b = new AgentModel("bob",   { baseUrl });
  const c = new AgentModel("carol", { baseUrl });
  room.addModel(a); room.addModel(b); room.addModel(c);

  const tm = new TurnManager(room, [a,b,c], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });
  tm.start();

  void room.broadcast("User", "What is f('hello')?");

  await waitUntil(() => mock.getReqs() >= 1, 3000);
  await waitUntil(() => mock.toolCounter.count >= 2, 3000);
  await sleep(100);
  tm.stop();

  expect(mock.toolCounter.count).toBeGreaterThanOrEqual(2);
  expect(a.delivered).toBeGreaterThan(0);
  expect(b.delivered).toBeGreaterThan(0);
  expect(c.delivered).toBeGreaterThan(0);
});
