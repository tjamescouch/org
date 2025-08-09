// main.ts — Bun: keepalive via timer + graceful shutdown

import { ChatRoom } from "./chat-room";
import { AgentModel } from "./agent-model";

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
  const bob   = new AgentModel("bob");
  room.addModel(alice);
  room.addModel(bob);

  const initialMessage =
    "Agents! Let's get to work on a project. It is a calculator written in typescript to be run by bun. Bob - you will do the coding. I will be the product person who makes the decisions.";

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
