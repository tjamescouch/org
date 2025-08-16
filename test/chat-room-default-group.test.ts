import ChatRoom from "../src/core/chat-room";
import AgentModel from "../src/core/entity/agent-model";

// NOTE: This suite intentionally avoids TurnManager / LLM IO.
// It exercises only ChatRoom.broadcast() + the default @group routing shim.

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

test("messages without an explicit target route to @group by default", async () => {
  const room = new ChatRoom();
  const alice = new AgentModel("alice");
  const bob   = new AgentModel("bob");
  const carol = new AgentModel("carol");
  room.addModel(alice);
  room.addModel(bob);
  room.addModel(carol);

  const events: any[] = [];
  // Minimal event emitter is provided by ChatRoom shim; in tests we treat it as 'any'.
  (room as any).events?.on?.("send", (ev: any) => events.push(ev));

  await room.broadcast("alice", "hello everyone"); // no @recipient -> should route to @group
  await sleep(5); // allow microtasks to flush

  // We saw at least one 'send' with to='@group' and routedBy='default-group'
  expect(events.some(e => e?.to === "@group" && e?.routedBy === "default-group")).toBe(true);
});

test("messages with an explicit @recipient are NOT treated as @group", async () => {
  const room = new ChatRoom();
  const alice = new AgentModel("alice");
  const bob   = new AgentModel("bob");
  const carol = new AgentModel("carol");
  room.addModel(alice);
  room.addModel(bob);
  room.addModel(carol);

  const events: any[] = [];
  (room as any).events?.on?.("send", (ev: any) => events.push(ev));

  await room.broadcast("alice", "@bob hi there");
  await sleep(5);

  // No synthetic @group routing should be emitted for explicit targets
  expect(events.some(e => e?.to === "@group" && e?.routedBy === "default-group")).toBe(false);
});
