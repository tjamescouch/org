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

// --- VT100 scroll region helpers + guard to avoid intercept recursion
let TUI_DRAWING = false;
function withTUIDraw<T>(fn: () => T): T { TUI_DRAWING = true; try { return fn(); } finally { TUI_DRAWING = false; } }
function setScrollRegion(top: number, bottom: number) { process.stdout.write(`\x1b[${top};${bottom}r`); }
function clearScrollRegion() { process.stdout.write(`\x1b[r`); }

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

// Intercept arbitrary writes to stdout (from other modules) and render via log buffer
const realWrite = process.stdout.write.bind(process.stdout);
let streamBuf = "";
(process.stdout as any).write = function (chunk: any, encoding?: any, cb?: any) {
  // Allow our own TUI drawing to pass through unmodified
  if (TUI_DRAWING) return realWrite(chunk, encoding, cb);
  try {
    const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    streamBuf += s;
    // Flush on newline; keep partial lines buffered
    let idx;
    while ((idx = streamBuf.indexOf("\n")) !== -1) {
      const line = streamBuf.slice(0, idx);
      streamBuf = streamBuf.slice(idx + 1);
      appendLog(line);
    }
    // If caller passed a callback, call it now
    if (typeof cb === 'function') cb();
    return true;
  } catch (e) {
    // On error, fall back to real write
    return realWrite(chunk, encoding, cb);
  }
} as any;

function drawHeader(status: string) {
  withTUIDraw(() => {
    const cols = process.stdout.columns || 80;
    const text = `${C.bold}${C.cyan}${status}${C.reset}`;
    const pad = Math.max(0, cols - stripAnsi(text).length);
    process.stdout.write(CSI.home + text + " ".repeat(pad) + "\n");
  });
}

function drawBody() {
  withTUIDraw(() => {
    const rows = process.stdout.rows || 24;
    const bodyRows = Math.max(0, rows - 2);
    process.stdout.write(`\x1b[2;1H`);
    const slice = logBuf.slice(-bodyRows);
    const fill = Array(Math.max(0, bodyRows - slice.length)).fill("");
    const out = [...fill, ...slice].join("\n");
    process.stdout.write(out);
  });
}

function drawFooter() {
  withTUIDraw(() => {
    const cols = process.stdout.columns || 80;
    const hint = `${C.gray}[q] quit  [i] interject  [s] system  (Ctrl+C to quit)${C.reset}`;
    const pad = Math.max(0, cols - stripAnsi(hint).length);
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H` + hint + " ".repeat(pad));
  });
}

function stripAnsi(s: string) { return s.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ""); }

function redraw(status = currentStatus) {
  withTUIDraw(() => {
    process.stdout.write(CSI.hide + CSI.clear);
    const rows = process.stdout.rows || 24;
    // Header at row 1, footer at last row -> body scroll region is 2..(rows-1)
    setScrollRegion(2, Math.max(2, rows - 1));
    drawHeader(status);
    drawBody();
    drawFooter();
  });
}

let currentStatus = "org: multi-agent session";

function promptLine(q: string): Promise<string> {
  const rows = process.stdout.rows || 24;
  withTUIDraw(() => { clearScrollRegion(); process.stdout.write(`${CSI.show}\x1b[${rows - 1};1H\x1b[2K`); });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(q, (ans) => {
      rl.close();
      withTUIDraw(() => { process.stdout.write(CSI.hide); redraw(); });
      resolve(ans);
    });
  });
}

async function gracefulQuit(room: any, keepAlive: any) {
  try { clearInterval(keepAlive); } catch {}
  try { if (typeof room?.shutdown === "function") await room.shutdown(); } catch (e) { appendLog(`${C.red}[shutdown error]${C.reset} ${String(e)}`); }
  withTUIDraw(() => { clearScrollRegion(); process.stdout.write(CSI.show + "\n"); });
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
  process.stdout.on("resize", () => { withTUIDraw(() => { const rows = process.stdout.rows || 24; setScrollRegion(2, Math.max(2, rows - 1)); }); redraw(); });

  // initial draw: set scroll region once
  withTUIDraw(() => { const rows = process.stdout.rows || 24; setScrollRegion(2, Math.max(2, rows - 1)); });
  process.stdout.write(CSI.hide);
  redraw();
}

app().catch((e) => {
  process.stdout.write(CSI.show);
  console.error(`${C.red}App crashed:${C.reset} ${String(e)}`);
  process.exit(1);
});