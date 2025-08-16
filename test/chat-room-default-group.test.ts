import ChatRoom from "../src/core/chat-room";
import AgentModel from "../src/core/entity/agent-model";

const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));

/**
 * NOTE: We DO NOT await room.broadcast here.
 * In this codebase, broadcast awaits deeper delivery which can trigger
 * the agent loop / transport and hang the test if the model is unavailable.
 * We only care about the default routing shim emitting a 'send' to @group.
 */

test("messages without an explicit target route to @group by default", async () => {
  const room = new ChatRoom();
  room.addModel(new AgentModel("alice"));
  room.addModel(new AgentModel("bob"));
  room.addModel(new AgentModel("carol"));

  const events: any[] = [];
  (room as any).events?.on?.("send", (ev: any) => events.push(ev));

  // Fire-and-forget – let the shim emit synchronously, then assert.
  void room.broadcast("alice", "hello everyone");
  await sleep(20);

  expect(events.some(e => e?.to === "@group" && e?.routedBy === "default-group")).toBe(true);
});

test("messages with an explicit @recipient are NOT treated as @group", async () => {
  const room = new ChatRoom();
  room.addModel(new AgentModel("alice"));
  room.addModel(new AgentModel("bob"));
  room.addModel(new AgentModel("carol"));

  const events: any[] = [];
  (room as any).events?.on?.("send", (ev: any) => events.push(ev));

  void room.broadcast("alice", "@bob hi there");
  await sleep(20);

  expect(events.some(e => e?.to === "@group" && e?.routedBy === "default-group")).toBe(false);
});
