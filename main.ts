// -------------------------------------------------------------------
// 5️⃣  Example usage (run with `npx ts-node group-chat.ts`)

import { ChatRoom } from "./chat-room";
import { AgentModel } from "./agent-model";

// -------------------------------------------------------------------
async function app() {
  const room = new ChatRoom();

  // Create three simple models – give them distinct IDs
  const alice = new AgentModel("alice");
  const bob   = new AgentModel("bob");
  const carol = new AgentModel("carol");

  // Register them in the same room
  room.addModel(alice);
  room.addModel(bob);
  //room.addModel(carol);

  // Kick‑off the conversation – let Alice say the first thing.
  // (Alice uses the same broadcast helper that the others use.)
  //const initialMessage = "Agents! Let's get to work on a project. It is a calculator written in typescript to be run by bun. Bob - you will do the coding. Carol - you will do the architecture. I will be the product person who makes the decisions.";
  const initialMessage = "Agents! Let's get to work on a project. It is a calculator written in typescript to be run by bun. Bob - you will do the coding. I will be the product person who makes the decisions.";
  await alice.initialMessage({
    role: 'assistant',
    ts: Date.now().toString(),
    from: 'alice',
    content: initialMessage,
    read: false,
  });

  // Give the async replies a moment to settle.
  // In a real app you’d probably await something else or listen to events.
  await new Promise((r) => setTimeout(r, 2000));
}

app().catch((e) => {
  console.error("Demo crashed:", e);
});
