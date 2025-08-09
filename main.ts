import { ChatRoom } from "./chat-room";
import { AgentModel } from "./agent-model";

// Harden runtime so hidden async errors don't kill the process silently
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  (e) => { console.error("[uncaughtException]", e); process.exitCode = 1; });

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function app() {
  const room = new ChatRoom();

  // Create models – give them distinct IDs
  const alice = new AgentModel("alice");
  const bob   = new AgentModel("bob");
  // const carol = new AgentModel("carol");

  // Register in the same room
  room.addModel(alice);
  room.addModel(bob);
  // room.addModel(carol);

  // Kick off the conversation – Alice speaks first.
  const initialMessage =
    "Agents! Let's get to work on a project. It is a calculator written in typescript to be run by bun. Bob - you will do the coding. I will be the product person who makes the decisions.";

  await alice.initialMessage({
    role: "assistant",
    ts: Date.now().toString(),
    from: "alice",
    content: initialMessage,
    read: false,
  });

  // KEEP RUNNING until Ctrl-C (replaces the 2s sleep that caused early exit)
  await waitForSignal();

  // Graceful shutdown if implemented
  if (typeof (room as any).shutdown === "function") {
    await (room as any).shutdown();
  }
}

app().catch((e) => {
  console.error("App crashed:", e);
  process.exit(1);
});