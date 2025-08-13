// main.ts — Interactive (curses) mode with --interactive, else script mode
// - Ctrl+C quits
// - Footer banner pinned only in interactive mode
// - Colors preserved
// - In script mode, no TUI interception—raw console output so streams without \n still appear

import { AgentModel } from "./agent-model";
import { ChatRoom } from "./chat-room";
import { interruptChat } from "./chat";
import readline from "readline";
import { CSI } from "./tui"; // expects: clear, home, hide, show, rev, nrm

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

/* -------------------- args -------------------- */
const argv = Bun.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = argv.findIndex(a => a === name || a.startsWith(name + "="));
  if (idx === -1) return undefined;
  const v = argv[idx];
  const eq = v.indexOf("=");
  if (eq >= 0) return v.slice(eq + 1);
  const next = argv[idx + 1];
  if (next && !next.startsWith("-")) return next;
  return "";
}
const HAS_FLAG = (f: string) => argv.includes(f) || argv.some(a => a.startsWith(f + "="));

// Interactive (curses) mode by default when running on a TTY.
// Use --no-interactive to force script mode. --interactive still forces it on.
const INTERACTIVE =
  (HAS_FLAG("--interactive") || (!HAS_FLAG("--no-interactive") && !!process.stdout.isTTY && !!process.stdin.isTTY));
const PROMPT_ARG = getArg("--prompt");

/* -------------------- colors -------------------- */
const C = {
  reset: "\x1b[0m", bold:  "\x1b[1m", dim:   "\x1b[2m",
  red:   "\x1b[31m", green: "\x1b[32m", yellow:"\x1b[33m",
  blue:  "\x1b[34m", magenta:"\x1b[35m", cyan:  "\x1b[36m", gray:  "\x1b[90m",
} as const;

// --- Timestamp and global logger utilities ---
function ts() { return new Date().toLocaleTimeString(); }
function colorize(msg: string, color: string = "") { return `${color}${msg}${C.reset}`; }

// Global append hook so other modules can log into the TUI buffer directly
(globalThis as any).__appendLog = (line: string) => appendLog(line);

// Global log functions used across the app (agent-model imports via globalThis)
(globalThis as any).__log = (msg: string, color: keyof typeof C | "" = "") => {
  const prefix = `${C.gray}[${ts()}]${C.reset} `;
  const body = color ? colorize(msg, (C as any)[color] ?? "") : msg;
  if (INTERACTIVE) appendLog(prefix + body + "\n");
  else process.stdout.write(prefix + body + "\n");
};
(globalThis as any).__logError = (msg: string) => {
  const prefix = `${C.gray}[${ts()}]${C.reset} `;
  const body = `${C.red}${msg}${C.reset}`;
  if (INTERACTIVE) appendLog(prefix + body + "\n");
  else process.stderr.write(prefix + body + "\n");
};

const ESC = {
  altScreenOn: "\x1b[?1049h",
  altScreenOff: "\x1b[?1049l",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  disableWrap: "\x1b[?7l",
  enableWrap: "\x1b[?7h",
};

/* -------------------- minimal TUI (only when INTERACTIVE) -------------------- */
let TUI_DRAWING = false; // guard to avoid intercept recursion
const LOG_LIMIT = 2000; // ring buffer lines
let logBuf: string[] = [];

function withTUIDraw<T>(fn: () => T): T { TUI_DRAWING = true; try { return fn(); } finally { TUI_DRAWING = false; } }
function clearScrollRegion() { process.stdout.write(`\x1b[r`); }

function stripAnsi(s: string) { return s.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ""); }

function appendLog(s: string) {
  const norm = (s || "").replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
  const lines = norm.split(/\n/);
  for (const line of lines) {
    logBuf.push(line);
    if (logBuf.length > LOG_LIMIT) logBuf.shift();
  }
  redraw();
}

function drawHeader(status: string) {
  withTUIDraw(() => {
    const cols = process.stdout.columns || 80;
    const controls = `${C.gray}[q] quit  [i] interject  [s] system  (Ctrl+C to quit)${C.reset}`;
    const text = `${C.bold}${C.cyan}${status}${C.reset}  ${controls}`;
    const pad = Math.max(0, cols - stripAnsi(text).length);
    process.stdout.write(CSI.home + `\x1b[2K` + text + " ".repeat(pad) + "\n");
  });
}

function drawBody() {
  withTUIDraw(() => {
    const rows = process.stdout.rows || 24;
    const bodyRows = Math.max(0, rows - 2);
    const slice = logBuf.slice(-bodyRows);
    const fill = Array(Math.max(0, bodyRows - slice.length)).fill("");
    const lines = [...fill, ...slice];
    process.stdout.write(`\x1b[2;1H`);
    for (let i = 0; i < bodyRows; i++) {
      const line = lines[i] ?? "";
      process.stdout.write(`\x1b[2K` + line + (i < bodyRows - 1 ? "\n" : ""));
    }
    process.stdout.write(`\x1b[0J`);
  });
}

function redraw(status = currentStatus) {
  withTUIDraw(() => {
    process.stdout.write(CSI.hide + CSI.clear);
    drawHeader(status);
    drawBody();
  });
}

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

// In interactive mode, intercept stdout/stderr so footer stays pinned
let uninstallInterceptors: (() => void) | null = null;
function installInterceptors() {
  if (!INTERACTIVE) return;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let outBuf = "", errBuf = "";
  let idleTimer: NodeJS.Timeout | null = null;

  let pulseTimer: NodeJS.Timeout | null = null;

  const flushIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (outBuf) { const b = outBuf; outBuf = ""; appendLog(b); }
    if (errBuf) { const b = errBuf; errBuf = ""; appendLog(b); }
  };
  (process.stdout as any).write = (chunk: any, enc?: any, cb?: any) => {
    if (TUI_DRAWING) return realOut(chunk, enc, cb);
    let s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    s = s.replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
    outBuf += s;
    // Flush full lines immediately; keep partials but also idle-flush so UI updates even without \n
    let idx;
    while ((idx = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, idx + 1);
      outBuf = outBuf.slice(idx + 1);
      appendLog(line);
    }
    if (typeof cb === 'function') cb();
    return true;
  };
  (process.stderr as any).write = (chunk: any, enc?: any, cb?: any) => {
    if (TUI_DRAWING) return realErr(chunk, enc, cb);
    let s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    s = s.replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
    errBuf += s;
    let idx;
    while ((idx = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, idx + 1);
      errBuf = errBuf.slice(idx + 1);
      appendLog(line);
    }
    if (typeof cb === 'function') cb();
    return true;
  };

  pulseTimer = setInterval(() => {
    if ((outBuf || errBuf) && !TUI_DRAWING) redraw();
  }, 50);

  uninstallInterceptors = () => {
    (process.stdout as any).write = realOut as any;
    (process.stderr as any).write = realErr as any;
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
    flushIdle();
  };
}

async function gracefulQuit(room: any, keepAlive: any) {
  try { clearInterval(keepAlive); } catch {}
  try { if (typeof room?.shutdown === "function") await room.shutdown(); } catch (e) { if (INTERACTIVE) appendLog(`${C.red}[shutdown error]${C.reset} ${String(e)}`); else console.error("[shutdown error]", e); }
  if (INTERACTIVE) withTUIDraw(() => { clearScrollRegion(); process.stdout.write(CSI.show + "\n"); });
  if (uninstallInterceptors) uninstallInterceptors();

  if (INTERACTIVE) withTUIDraw(() => {
    clearScrollRegion();
    process.stdout.write(ESC.show + ESC.altScreenOff + "\n");
  });

  process.exit(0);
}

/* -------------------- kickoff helpers -------------------- */
async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function askKickoffPrompt(defaultPrompt: string): Promise<string> {
  if (!INTERACTIVE) return defaultPrompt; // no prompt in script mode
  const entered = await promptLine(`${C.bold}${C.blue}Enter kickoff prompt${C.reset} [${defaultPrompt}]: `);
  return (entered.trim() === "" ? defaultPrompt : entered.trim());
}

/* -------------------- app -------------------- */
let currentStatus = "org: multi-agent session";

async function app() {
  const room = new ChatRoom();

  const alice = new AgentModel("alice", "openai/gpt-oss-120b");
  const carol = new AgentModel("carol", "openai/gpt-oss-120b");
  const bob   = new AgentModel("bob",   "openai/gpt-oss-120b");
  room.addModel(alice); room.addModel(carol); room.addModel(bob);

  const defaultKickoffPrompt =
    "Agents! Let's get to work on a new and fun project. The project is a sockets/tcp based p2p file transfer and chat app with no middle man. The only requirement is for it C++ compiled with gcc or g++. Check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Incrementally add new features and focus on extensibility. Carol - you will do the architecture documents and README. I will be the product person who makes the decisions.";

  // Decide kickoff prompt source
  let kickoffPrompt = defaultKickoffPrompt;
  if (typeof PROMPT_ARG === "string" && PROMPT_ARG.length) {
    kickoffPrompt = PROMPT_ARG;
  } else {
    const piped = await readStdinAll();
    if (piped.trim().length) kickoffPrompt = piped.trim();
    else if (INTERACTIVE) kickoffPrompt = await askKickoffPrompt(defaultKickoffPrompt);
  }

  // Start
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);

  if (INTERACTIVE) {
    withTUIDraw(() => { process.stdout.write(ESC.altScreenOn + ESC.hide + CSI.clear); });
    // Setup TUI only now
    installInterceptors();
    const rows = process.stdout.rows || 24;
    withTUIDraw(() => { const bottom = Math.max(2, rows - 1); });
    currentStatus = "org: multi-agent session started";
    redraw();
    appendLog(`${C.magenta}Kickoff as Alice:${C.reset} ${kickoffPrompt}`);
  } else {
    // Script mode: print clear, raw lines
    (globalThis as any).__log(`${C.magenta}Kickoff as Alice:${C.reset} ${kickoffPrompt}`);
  }

  await alice.initialMessage({ role: "assistant", ts: Date.now().toString(), from: "alice", content: kickoffPrompt, read: false });

  // Interactive key controls only in TUI
  if (INTERACTIVE && process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", async (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === "\u0003") { // Ctrl+C
        currentStatus = "quitting…"; if (INTERACTIVE) redraw();
        await gracefulQuit(room, keepAlive);
        return;
      }
      const ch = s.length === 1 ? s : "";
      if (ch === "q") {
        currentStatus = "quitting…"; if (INTERACTIVE) redraw();
        await gracefulQuit(room, keepAlive);
        return;
      }
      if (ch === "i") {
        interruptChat(); await new Promise(r => setTimeout(r, 100));
        currentStatus = "interject (user)"; redraw();
        const txt = await promptLine(`${C.bold}[you] > ${C.reset}`);
        const msg = (txt ?? "").trim();
        if (msg) await room.broadcast("User", msg);
        if (msg) (globalThis as any).__log(`[you] ${msg}`);
        currentStatus = msg ? "sent interject" : "interject: (empty)"; redraw();
        return;
      }
      if (ch === "s") {
        interruptChat(); await new Promise(r => setTimeout(r, 100));
        currentStatus = "system message"; redraw();
        const txt = await promptLine(`${C.bold}[system] > ${C.reset}`);
        const msg = (txt ?? "").trim();
        if (msg) await room.broadcast("System", msg);
        currentStatus = msg ? "sent system message" : "system: (empty)"; redraw();
        return;
      }
    });
    process.stdout.on("resize", () => { redraw(); });
  }
}

app().catch((e) => {
  if (INTERACTIVE) { process.stdout.write(CSI.show); }
  (globalThis as any).__logError(`App crashed: ${String(e)}`);
  process.exit(1);
});