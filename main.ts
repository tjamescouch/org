// main.ts — Bun: keepalive via timer + graceful shutdown

import { AgentModel } from "./agent-model";
import { ChatRoom } from "./chat-room";
import readline from "readline";

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
}

async function promptInterject(): Promise<string> {
  const rl = createRL();
  return new Promise((resolve) => {
    rl.question("\n[interject] > ", (answer) => { rl.close(); resolve(answer); });
  });
}

async function askKickoffPrompt(defaultPrompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const promptText = `Enter kickoff prompt [${defaultPrompt}]: `;
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() === "" ? defaultPrompt : answer);
    });
  });
}

async function app() {
  const room = new ChatRoom();

  const alice = new AgentModel("alice", "gpt-oss:20b-64k");
  const carol = new AgentModel("carol", "gpt-oss:20b-64k");
  const bob   = new AgentModel("bob", "gpt-oss:20b-64k");
  room.addModel(alice);
  room.addModel(carol);
  room.addModel(bob);

  const defaultKickoffPrompt =
    "Agents! Let's get to work on a new and fun project. The project is a sockets/tcp based p2p file transfer and chat app with no middle man. The only requirement is for it C++ compiled with gcc or g++. Check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Incrementally add new features and focus on extensibility. Carol - you will do the architecture, please keep architecture documents and readme up-to-date. I will be the product person who makes the decisions.";

  const kickoffPrompt = await askKickoffPrompt(defaultKickoffPrompt);

  await alice.initialMessage({
    role: "assistant",
    ts: Date.now().toString(),
    from: "alice",
    content: kickoffPrompt,
    read: false,
  });

  // --- Interactive interjection controls (Unix-style):
// Ctrl+C → pause and let user inject a message; Ctrl+D (EOF) → graceful exit
process.on("SIGINT", async () => {
  try {
    const text = await promptInterject();
    if (text && text.trim().length) {
      await room.broadcast("User", text.trim());
    } else {
      console.log("[interject] (empty)");
    }
  } catch (e) {
    console.error("[interject error]", e);
  }
});

// Detect EOF on stdin (Ctrl+D) and shut down
if (process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on("end", async () => {
    console.log("\n[EOF] Ctrl+D detected – exiting.");
    try {
      if (typeof (room as any).shutdown === "function") await (room as any).shutdown();
    } finally {
      process.exit(0);
    }
  });
}

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
