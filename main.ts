// main.ts — Bun TUI: raw key controls (q=quit, i=interject, s=system)
// 1) Ctrl+C / Ctrl+D behave as usual (no custom SIGINT/EOF handlers)
// 2) 'q' quits gracefully
// 3) 'i' prompts and broadcasts as User
// 4) 's' prompts and broadcasts as System
// Minimal ncurses-like TUI using ANSI escapes (no external deps)

import { AgentModel } from "./agent-model";
import { ChatRoom } from "./chat-room";
import { interruptChat } from "./chat";
import readline from "readline";
import { CSI } from "./tui";

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });



function drawFrame(status: string, hint = "[q] quit  [i] interject  [s] system  (Ctrl+C to SIGINT)") {
  const cols = process.stdout.columns || 80;
  const bar = (text: string) => {
    const pad = Math.max(0, cols - text.length);
    return text + " ".repeat(pad);
  };
  process.stdout.write(CSI.hide + CSI.clear + CSI.home);
  process.stdout.write(CSI.rev + bar(status.slice(0, cols)) + CSI.nrm + "\n");
  process.stdout.write(bar(hint.slice(0, cols)) + "\n\n");
}

function logLine(s: string) {
  process.stdout.write(s.replace(/\r?\n/g, "\n") + "\n");
}

function promptLine(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(q, (ans) => { rl.close(); resolve(ans); });
  });
}

async function gracefulQuit(room: any, keepAlive: any) {
  try { clearInterval(keepAlive); } catch {}
  try { if (typeof room?.shutdown === "function") await room.shutdown(); } catch (e) { console.error("[shutdown error]", e); }
  process.stdout.write(CSI.show);
  process.exit(0);
}

/* -------------------- app -------------------- */
async function app() {
  const room = new ChatRoom();

  const alice = new AgentModel("alice", "openai/gpt-oss-120b");
  const carol = new AgentModel("carol", "openai/gpt-oss-120b");
  const bob   = new AgentModel("bob",   "openai/gpt-oss-120b");
  room.addModel(alice); room.addModel(carol); room.addModel(bob);

  const defaultKickoffPrompt =
    "Agents! Let's get to work on a new and fun project. The project is a sockets/tcp based p2p file transfer and chat app with no middle man. The only requirement is for it C++ compiled with gcc or g++. Check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Incrementally add new features and focus on extensibility. Carol - you will do the architecture, please keep architecture documents and readme up-to-date. I will be the product person who makes the decisions.";

  // kickoff prompt — SSH-keygen style (hit enter to accept default)
  const entered = await promptLine(`Enter kickoff prompt [${defaultKickoffPrompt}]: `);
  const kickoffPrompt = (entered.trim() === "" ? defaultKickoffPrompt : entered.trim());

  drawFrame("org: multi-agent session started");
  logLine(`Kickoff as Alice: ${kickoffPrompt}`);

  await alice.initialMessage({ role: "assistant", ts: Date.now().toString(), from: "alice", content: kickoffPrompt, read: false });

  // Keep the process alive
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);

  // --- Raw key control: q (quit), i (interject), s (system)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", async (buf: Buffer) => {
      const s = buf.toString("utf8");
      const ch = s.length === 1 ? s : "";  // we only handle single printable keys here

      if (ch === "q") {
        drawFrame("quitting…");
        await gracefulQuit(room, keepAlive);
        return;
      }

      if (ch === "i") {
        // Interrupt any in-flight generation, then prompt
        interruptChat();
        await new Promise(r => setTimeout(r, 100));
        drawFrame("interject (user)");
        const txt = await promptLine("[you] > ");
        const msg = (txt ?? "").trim();
        if (msg) {
          await room.broadcast("User", msg);
          drawFrame("sent interject");
        } else {
          drawFrame("interject: (empty)");
        }
        return;
      }

      if (ch === "s") {
        interruptChat();
        await new Promise(r => setTimeout(r, 100));
        drawFrame("system message");
        const txt = await promptLine("[system] > ");
        const msg = (txt ?? "").trim();
        if (msg) {
          await room.broadcast("System", msg);
          drawFrame("sent system message");
        } else {
          drawFrame("system: (empty)");
        }
        return;
      }

      // Let Ctrl+C / Ctrl+D behave normally:
      // - Ctrl+C will SIGINT the process (we haven't overridden default)
      // - Ctrl+D in raw mode appears as \\u0004; we ignore here so EOF behavior is up to the shell/rl
    });
  }

  // redraw on resize
  process.stdout.on("resize", () => drawFrame("org: multi-agent session"));
}

app().catch((e) => {
  process.stdout.write(CSI.show);
  console.error("App crashed:", e);
  process.exit(1);
});