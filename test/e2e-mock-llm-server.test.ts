
// test/e2e-mock-llm-server.test.ts
import "./setup"; // ensure ExecutionGate DIRECT, no interactivity
import { startMockLLMServer } from "./mock-llm";
import { ChatRoom } from "../src/core/chat-room";
import { AgentModel } from "../src/core/entity/agent-model";
import { TurnManager } from "../src/core/turn-manager";

test("e2e: mock LLM always uses 2 tools then returns @group > routes OpenAI chat → two tools → @group", async () => {
  const server = await startMockLLMServer();
  // Route OpenAI transport to our mock server
  process.env.OAI_BASE = server.url;

  const room = new ChatRoom();
  console.log("ROOM", room);
  const a = new AgentModel("alice");
  const b = new AgentModel("bob");  
  const c = new AgentModel("carol");

  room.addModel(a);
  room.addModel(b);
  room.addModel(c);

  const tm = new TurnManager(room, [a, b, c], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });

  const groupCounts = new Map<string, number>();
  room.events.on("send", (ev: any) => {
    if (ev?.to === "group" && ev?.from) {
      groupCounts.set(ev.from, (groupCounts.get(ev.from) ?? 0) + 1);
    }
  });

  tm.start();
  await room.broadcast("User", "Kickoff");

  // Wait for two tools (echo one/two) + final @group
  const t0 = Date.now();
  while (
    (groupCounts.get("alice") ?? 0) < 1 &&
    Date.now() - t0 < 5000
  ) {
    await sleep(25);
  }

  tm.stop();
  await server.close();

  expect(groupCounts.get("alice") ?? 0).toBe(1);
});
