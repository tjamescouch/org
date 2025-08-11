// main.ts — Bun: keepalive via timer + graceful shutdown

import { AgentModel } from "./agent-model";
import  { ChatRoom } from "./chat-room";

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function app() {
  const room = new ChatRoom();

  const alice = new AgentModel("alice");
  const carol = new AgentModel("carol");
  const bob   = new AgentModel("bob");
  room.addModel(alice);
  room.addModel(carol);
  room.addModel(bob);

  const initialMessage =
    "Agents! Let's get to work on a new and fun project. The project is a web socket based p2p file transfer and chat app with no middle man. The only requirement is for it C++ compiled with gcc or g++. Check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Incrementally add new features and focus on extensibility. Carol - you will do the architecture, please keep architecture documents and readme up-to-date. I will be the product person who makes the decisions.";

  await alice.initialMessage({
    role: "assistant",
    ts: Date.now().toString(),
    from: "alice",
    content: initialMessage,
    read: false,
  });

  // --- Bun-specific: a Promise alone won't keep the runtime alive.
  // Hold a *real* handle. A ticking interval is simplest.
  const keepAlive = setInterval(() => { /* tick to stay alive */ }, 60_000);

  // Wait for Ctrl-C / SIGTERM
  await waitForSignal();

  clearInterval(keepAlive);

  if (typeof (room as any).shutdown === "function") {
    await (room as any).shutdown();
  }
}

app().catch((e) => {
  console.error("App crashed:", e);
  process.exit(1);
});
