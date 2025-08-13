// main.ts — Bun TUI: raw key controls + pinned footer + colored logging
// Requirements:
// 1) Ctrl+C should quit (graceful)
// 2) Footer banner stays pinned at the very bottom
// 3) Bots/tools outputs look nice and respect colors

import { AgentModel } from "./agent-model";
import { ChatRoom } from "./chat-room";
import { interruptChat } from "./chat";
import readline from "readline";
import { CSI } from "./tui"; // expects: clear, home, hide, show, rev, nrm

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

/* -------------------- colors -------------------- */
const C = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  red:   "\x1b[31m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  blue:  "\x1b[34m",
  magenta:"\x1b[35m",
  cyan:  "\x1b[36m",
  gray:  "\x1b[90m",
};

/* -------------------- tiny TUI with pinned footer -------------------- */
const LOG_LIMIT = 2000; // ring buffer lines
let logBuf: string[] = [];

function appendLog(s: string) {
  const lines = (s || "").replace(/\r\n/g, "\n").split(/\n/);
  for (const line of lines) {
    logBuf.push(line);
    if (logBuf.length > LOG_LIMIT) logBuf.shift();
  }
  redraw();
}

function drawHeader(status: string) {
  const cols = process.stdout.columns || 80;
  const text = `${C.bold}${C.cyan}${status}${C.reset}`;
  const pad = Math.max(0, cols - stripAnsi(text).length);
  process.stdout.write(CSI.home + text + " ".repeat(pad) + "\n");
}

function drawFooter() {
  const cols = process.stdout.columns || 80;
  const hint = `${C.gray}[q] quit  [i] interject  [s] system  (Ctrl+C to quit)${C.reset}`;
  const pad = Math.max(0, cols - stripAnsi(hint).length);
  // Move cursor to last row
  const rows = process.stdout.rows || 24;
  process.stdout.write(`\x1b[${rows};1H` + hint + " ".repeat(pad));
}

function drawBody() {
  const rows = process.stdout.rows || 24;
  const bodyRows = Math.max(0, rows - 2); // header + footer consume 2 lines
  // Place cursor at row 2, col 1, clear to footer-1
  process.stdout.write(`\x1b[2;1H`);
  // Compute slice from the end
  const slice = logBuf.slice(-bodyRows);
  // Ensure exactly bodyRows lines printed to overwrite old content
  const fill = Array(Math.max(0, bodyRows - slice.length)).fill("");
  const out = [...fill, ...slice].join("\n");
  process.stdout.write(out);
}

function stripAnsi(s: string) { return s.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ""); }

function redraw(status = currentStatus) {
  process.stdout.write(CSI.hide + CSI.clear);
  drawHeader(status);
  drawBody();
  drawFooter();
}

let currentStatus = "org: multi-agent session";

function promptLine(q: string): Promise<string> {
  // Temporarily show cursor and place prompt on the line above the footer
  const rows = process.stdout.rows || 24;
  process.stdout.write(`${CSI.show}\x1b[${rows - 1};1H\x1b[2K`);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(q, (ans) => { rl.close(); process.stdout.write(CSI.hide); redraw(); resolve(ans); });
  });
}

async function gracefulQuit(room: any, keepAlive: any) {
  try { clearInterval(keepAlive); } catch {}
  try { if (typeof room?.shutdown === "function") await room.shutdown(); } catch (e) { appendLog(`${C.red}[shutdown error]${C.reset} ${String(e)}`); }
  process.stdout.write(CSI.show + "\n");
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
    "Agents! Let's get to work on a new and fun project. The project is a sockets/tcp based p2p file transfer and chat app with no middle man. The only requirement is for it C++ compiled with gcc or g++. Check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Incrementally add new features and focus on extensibility. Carol - you will do the architecture documents and README. I will be the product person who makes the decisions.";

  // kickoff prompt — SSH-keygen style (Enter to accept default)
  currentStatus = "kickoff";
  redraw();
  const entered = await promptLine(`${C.bold}${C.blue}Enter kickoff prompt${C.reset} [${defaultKickoffPrompt}]: `);
  const kickoffPrompt = (entered.trim() === "" ? defaultKickoffPrompt : entered.trim());

  currentStatus = "org: multi-agent session started";
  redraw();
  appendLog(`${C.magenta}Kickoff as Alice:${C.reset} ${kickoffPrompt}`);

  await alice.initialMessage({ role: "assistant", ts: Date.now().toString(), from: "alice", content: kickoffPrompt, read: false });

  // Keep the process alive
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);

  // Override console to route through TUI and keep footer pinned
  const realLog = console.log.bind(console);
  const realErr = console.error.bind(console);
  console.log = (...args: any[]) => appendLog(args.map(a => String(a)).join(" "));
  console.error = (...args: any[]) => appendLog(args.map(a => String(a)).join(" "));

  // --- Raw key control: q (quit), i (interject), s (system)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", async (buf: Buffer) => {
      const s = buf.toString("utf8");
      // Ctrl+C should quit: many terminals send "\u0003"
      if (s === "\u0003") {
        currentStatus = "quitting…";
        redraw();
        await gracefulQuit(room, keepAlive);
        return;
      }
      const ch = s.length === 1 ? s : "";  // single printable keys

      if (ch === "q") {
        currentStatus = "quitting…";
        redraw();
        await gracefulQuit(room, keepAlive);
        return;
      }

      if (ch === "i") {
        // Interrupt any in-flight generation, then prompt
        interruptChat();
        await new Promise(r => setTimeout(r, 100));
        currentStatus = "interject (user)";
        redraw();
        const txt = await promptLine(`${C.bold}[you] > ${C.reset}`);
        const msg = (txt ?? "").trim();
        if (msg) {
          await room.broadcast("User", msg);
          currentStatus = "sent interject";
        } else {
          currentStatus = "interject: (empty)";
        }
        redraw();
        return;
      }

      if (ch === "s") {
        interruptChat();
        await new Promise(r => setTimeout(r, 100));
        currentStatus = "system message";
        redraw();
        const txt = await promptLine(`${C.bold}[system] > ${C.reset}`);
        const msg = (txt ?? "").trim();
        if (msg) {
          await room.broadcast("System", msg);
          currentStatus = "sent system message";
        } else {
          currentStatus = "system: (empty)";
        }
        redraw();
        return;
      }

      // Ctrl+D (\u0004) / EOF: we do not intercept; terminal behavior applies
    });
  }

  // redraw on resize
  process.stdout.on("resize", () => redraw());

  // initial draw
  process.stdout.write(CSI.hide);
  redraw();
}

app().catch((e) => {
  process.stdout.write(CSI.show);
  console.error(`${C.red}App crashed:${C.reset} ${String(e)}`);
  process.exit(1);
});