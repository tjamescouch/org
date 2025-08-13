// main.ts — Bun: interactive kickoff + interject + graceful shutdown

import { AgentModel } from "./agent-model";
import { ChatRoom } from "./chat-room";
import { interruptChat } from "./chat";
import readline from "readline";

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

/* -------------------- interject state / helpers -------------------- */
let _interjecting = false;
let _lastSIGINT = 0;

function isExitCommand(s: string) {
  return /^(exit|quit|q)\s*$/i.test(s || "");
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const promptText = `Enter kickoff prompt [${defaultPrompt}]: `;
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() === "" ? defaultPrompt : answer);
    });
  });
}

/* -------------------- app -------------------- */
async function app() {
  const room = new ChatRoom();

  const alice = new AgentModel("alice", "gpt-oss:20b-64k");
  const carol = new AgentModel("carol", "gpt-oss:20b-64k");
  const bob   = new AgentModel("bob",   "gpt-oss:20b-64k");
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

  // Keep the process alive (Bun won't stay alive on a pending Promise alone)
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);

  // Don’t exit on Ctrl+D; just keep stdin flowing
  if (process.stdin.isTTY) process.stdin.resume();

  // Ctrl+C → interject: pause room, abort in-flight stream, prompt, inject, resume.
  process.on("SIGINT", async () => {
    const now = Date.now();
    if (_interjecting || (now - _lastSIGINT) < 400) return; // debounce
    _interjecting = true; _lastSIGINT = now;

    try {
      console.log("\n[Ctrl+C] Pausing and opening interject prompt...");
      if (typeof (room as any).pause === "function") (room as any).pause();

      // Abort any in-flight streaming so agents stop talking over the prompt
      interruptChat();
      await new Promise(r => setTimeout(r, 120)); // let stream settle

      const text = await promptInterject();
      const msg = (text ?? "").trim();

      if (!msg) {
        console.log("[interject] (empty)");
      } else if (isExitCommand(msg)) {
        console.log("[bye]");
        await shutdown(room, keepAlive);
        process.exit(0);
      } else {
        // User message bypasses pause inside chat-room.ts
        await room.broadcast("User", msg);
        // Nudge the agents to respond to the user, not to rerun prior commands
        await room.broadcast("System", "User interjected. Respond directly to the user's request; do not rerun previous commands unless necessary.");
      }
    } catch (e) {
      console.error("[interject error]", e);
    } finally {
      if (typeof (room as any).resume === "function") (room as any).resume();
      _interjecting = false;
    }
  });

  // SIGTERM → graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("\n[SIGTERM] shutting down...");
    await shutdown(room, keepAlive);
    process.exit(0);
  });
}

async function shutdown(room: any, keepAlive: any) {
  try {
    clearInterval(keepAlive);
  } catch {}
  try {
    if (typeof room?.shutdown === "function") {
      await room.shutdown();
    }
  } catch (e) {
    console.error("[shutdown error]", e);
  }
}

/* -------------------- boot -------------------- */
app().catch((e) => {
  console.error("App crashed:", e);
  process.exit(1);
});