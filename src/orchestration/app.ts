// main.ts — Interactive (curses) mode by default; script mode with --no-interactive
// Adds flexible persona/model selection via CLI flags
//   -a, --agent, --persona   name[=model]   (repeatable)
//   --agents                 CSV of name[=model]
//   --default-model          fallback model for agents without explicit model
// Examples:
//   bun main.ts -a alice=openai/gpt-oss-120b -a bob=google/gemma-3-27b -a carol
//   bun main.ts --agents "alice=gpt-oss:20b,carol,bob=lmstudio/my-local"
// Enforce single-flight networking across the app (and child modules)
process.env.LM_MAX_CONCURRENCY = "1";
import { AgentModel, BrightBlueTag, BrightRedTag, CyanTag, Reset, markUserInterject } from "../core/entity/agent-model";
import { TurnManager } from "../core/turn-manager";
import { ChatRoom } from "./chat-room";
import { interruptChat } from "../../chat";
import readline from "readline";
import { CSI } from "../ui/tui"; // expects: clear, home, hide, show, rev, nrm
import { setTimeout as setTimeoutPromise } from 'timers/promises'

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

// --- Simple floating banner (periodic console log) ---
let bannerTimer: NodeJS.Timeout | null = null;
function startBanner() {
  if (bannerTimer) return;
  bannerTimer = setInterval(() => {
    const t = new Date().toLocaleTimeString();
    // plain white-on-black so it scrolls with content
    console.log(`\n\x1b[97m\x1b[40m[q] Quit  [i] Interject  [s] Send system message  (Ctrl+C quits)  ${t}\x1b[0m`);
  }, 20_000);
}

function stopBanner() {
  if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
}


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

// --- Raw-mode & key handling (single handler; attach/detach safely)
let RAW_ENABLED = false;
let keyHandler: ((buf: Buffer) => void) | null = null;
let promptActive = false;
let lastKeyHandler: ((buf: Buffer) => void) | null = null;

function enableRaw() {
  if (!process.stdin.isTTY) return;
  if (RAW_ENABLED) return;
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  RAW_ENABLED = true;
}

function disableRaw() {
  if (!RAW_ENABLED) return;
  try { process.stdin.setRawMode?.(false); } catch {}
  RAW_ENABLED = false;
}

function attachKeys(handler: (buf: Buffer) => void) {
  if (!process.stdin.isTTY) return;
  if (keyHandler) return;
  keyHandler = handler;
  lastKeyHandler = handler;
  process.stdin.on("data", keyHandler);
  enableRaw();
}

function detachKeys() {
  if (!process.stdin.isTTY) return;
  if (!keyHandler) return;
  process.stdin.off("data", keyHandler);
  // keep lastKeyHandler for later re-attachment
  keyHandler = null;
  disableRaw();
}

const ESC = {
  altScreenOn: "\x1b[?1049h",
  altScreenOff: "\x1b[?1049l",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  disableWrap: "\x1b[?7l",
  enableWrap: "\x1b[?7h",
};

let currentStatus = "org: multi-agent session";

/* -------------------- Personas / Models parsing -------------------- */
interface AgentSpec { name: string; model: string; }
const DEFAULT_MODEL = getArg("--default-model") || "openai/gpt-oss-20b";

function parseAgentSpecs(): AgentSpec[] {
  const specs: AgentSpec[] = [];
  const seen = new Set<string>();

  // gather from repeated flags: -a, --agent, --persona
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-a" || a === "--agent" || a === "--persona") {
      const val = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "";
      if (val) parseOne(val);
    } else if (a.startsWith("-a=") || a.startsWith("--agent=") || a.startsWith("--persona=")) {
      parseOne(a.slice(a.indexOf("=") + 1));
    }
  }

  // --agents CSV (name[=model],name2[=model2])
  const csv = getArg("--agents");
  if (csv) {
    csv.split(/\s*,\s*/).filter(Boolean).forEach(parseOne);
  }

  // If nothing provided, default trio
  if (specs.length === 0) {
    ["alice", "carol", "bob"].forEach(n => push({ name: n, model: DEFAULT_MODEL }));
  }

  return specs;

  function parseOne(token: string) {
    const m = token.match(/^([a-zA-Z0-9_\-]+)(?:=(.+))?$/);
    if (!m) return;
    const name = m[1];
    const model = (m[2] && m[2].trim()) || DEFAULT_MODEL;
    push({ name, model });
  }
  function push(spec: AgentSpec) {
    const key = spec.name.toLowerCase();
    if (seen.has(key)) return; // ignore duplicates; first wins
    seen.add(key);
    specs.push(spec);
  }
}

/* -------------------- minimal TUI (only when INTERACTIVE) -------------------- */
let TUI_DRAWING = false; // guard to avoid intercept recursion
const LOG_LIMIT = 2000; // ring buffer lines
let logBuf: string[] = [];

function withTUIDraw<T>(fn: () => T): T {
  TUI_DRAWING = true;
  try { return fn(); }
  finally { TUI_DRAWING = false; }
}
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

function drawHeader(status: string, asString?: boolean): string | void {
  return status;
}

function drawBody(asString?: boolean): string | void {
  const rows = process.stdout.rows || 24;
  const bodyRows = Math.max(0, rows - 2);
  const slice = logBuf.slice(-bodyRows);
  const fill = Array(Math.max(0, bodyRows - slice.length)).fill("");
  const lines = [...fill, ...slice];
  if (asString) return lines.join("\n");
  else {
    withTUIDraw(() => {
      process.stdout.write(`\x1b[2;1H`);
      for (let i = 0; i < bodyRows; i++) {
        const line = lines[i] ?? "";
        process.stdout.write(`\x1b[2K` + line + (i < bodyRows - 1 ? "\n" : ""));
      }
      process.stdout.write(`\x1b[0J`);
    });
  }
}

function redraw(status = currentStatus) {
    const header = drawHeader(status, true) as string; // string
  //withTUIDraw(() => {
  //  const header = drawHeader(status, true) as string; // string
  //  const body = drawBody(true) as string;             // string
  //  const soft = "\x1b[36m"; const reset = "\x1b[0m";
  //  console.log(soft + header + "\n" + body + reset);
  //});
}

async function promptLine(q: string): Promise<string> {
  // Ensure we don't re-enter prompts
  if (promptActive) return "";
  promptActive = true;

  // Stop banner & detach raw key handler while we prompt
  stopBanner();
  detachKeys();

  // Make sure stdin is in cooked mode for readline
  try { process.stdin.setRawMode?.(false); } catch {}

  return await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.setPrompt(q);
    rl.prompt();

    rl.on("line", (ans) => {
      rl.close();
      try { process.stdout.write("\n"); } catch {}
      resolve(ans);
    });

    // Allow Ctrl+C to cancel without killing the app
    rl.on("SIGINT", () => {
      rl.close();
      try { process.stdout.write("\n"); } catch {}
      resolve("");
    });
  }).finally(() => {
    // Resume banner & key handling
    promptActive = false;
    if (INTERACTIVE && process.stdin.isTTY && lastKeyHandler) attachKeys(lastKeyHandler);
    startBanner();
  });
}

// In interactive mode, intercept stdout/stderr so footer stays pinned-ish
let uninstallInterceptors: (() => void) | null = null;
function installInterceptors() {
  if (!INTERACTIVE) return;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let outBuf = "", errBuf = "";

  (process.stdout as any).write = (chunk: any, enc?: any, cb?: any) => {
    // Bypass recursion during guarded draws
    if (TUI_DRAWING) return realOut(chunk as any, enc as any, cb as any);
    // Normalize line endings to avoid CR-sticking
    const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    const norm = s.replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
    // Write directly to terminal; do NOT buffer/redraw here to avoid stalls
    const ok = realOut(norm as any, enc as any, cb as any);
    return ok;
  };

  (process.stderr as any).write = (chunk: any, enc?: any, cb?: any) => {
    if (TUI_DRAWING) return realErr(chunk as any, enc as any, cb as any);
    const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    const norm = s.replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
    const ok = realErr(norm as any, enc as any, cb as any);
    return ok;
  };

  // No pulse redraw; rendering happens via normal console output

  uninstallInterceptors = () => {
    (process.stdout as any).write = realOut as any;
    (process.stderr as any).write = realErr as any;
  };
}

async function gracefulQuit(room: any, keepAlive: any) {
  try { clearInterval(keepAlive); } catch {}
  try { if (typeof room?.shutdown === "function") await room.shutdown(); } catch (e) { if (INTERACTIVE) appendLog(`${C.red}[shutdown error]${C.reset} ${String(e)}`); else console.error("[shutdown error]", e); }
  if (INTERACTIVE) withTUIDraw(() => { clearScrollRegion(); process.stdout.write(CSI.show + "\n"); });
  // stop floating banner
  try { stopBanner(); } catch {}

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
  const entered = await promptLine(`${C.bold}${C.blue}< ${C.reset} [${defaultPrompt}]: `);
  return (entered.trim() === "" ? defaultPrompt : entered.trim());
}

/* -------------------- app -------------------- */
async function app() {
  const room = new ChatRoom();
  // Decorate room.broadcast to record recent user messages for the scheduler
  {
    const origBroadcast = (room as any).broadcast?.bind(room);
    let lastUserTs = 0;
    if (typeof origBroadcast === "function") {
      (room as any).broadcast = async (from: string, content: string, to?: string) => {
        if (String(from).toLowerCase() === "user") lastUserTs = Date.now();
        return await origBroadcast(from, content, to);
      };
    }
    (room as any).hasFreshUserMessage = () => Date.now() - lastUserTs < 2000;
  }

  // Build agents from CLI
  const specs = parseAgentSpecs();
  const agents: AgentModel[] = specs.map(s => new AgentModel(s.name, s.model));
  for (const m of agents) room.addModel(m);

  // Round‑robin scheduler decoupled from message arrival
  const tm = new TurnManager(room as any, agents as any, {
    tickMs: 400,             // more responsive scheduler cadence    turnTimeoutMs: 8_000,    // shorter watchdog for snappier aborts
    idleBackoffMs: 1200,     // back off briefly after a no-op turn
    proactiveMs: 2500,       // allow a light proactive tick every ~2.5s per agent
  });
  tm.start();

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
    installInterceptors();
    currentStatus = `org: session started — agents: ${specs.map(a => `${a.name}${a.model?`:${a.model}`:''}`).join(', ')}`;
    withTUIDraw(() => redraw());
    (globalThis as any).__log(`Kickoff as ${specs[0]?.name || 'alice'}: ${kickoffPrompt}`);
    // Show controls banner once immediately
    console.log(`\n\x1b[97m\x1b[40m[q] Quit  [i] Interject  [s] Send system message  (Ctrl+C quits)  ${new Date().toLocaleTimeString()}\x1b[0m`);
  } else {
    (globalThis as any).__log(`Kickoff as ${specs[0]?.name || 'alice'}: ${kickoffPrompt}`);
    // Show controls banner once immediately
    console.log(`\n\x1b[97m\x1b[40m[q] Quit  [i] Interject  [s] Send system message  (Ctrl+C quits)  ${new Date().toLocaleTimeString()}\x1b[0m`);
  }

  // Send the kickoff as a broadcast to the room instead of initialMessage
  await room.broadcast("User", kickoffPrompt);

  // --- Interject & system message helpers (use promptLine and broadcast), capture room
  // --- Interject & system message helpers (stronger)
  const startInterject = async () => {
    if (promptActive) return;
    // Start a short TTL so the scheduler pauses while we abort streams & prompt.
    (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 2000;
    (globalThis as any).__PAUSE_INPUT = true;
    try {
      try { tm.pause(); } catch {}
      // Let agents know to yield their current hop quickly
      markUserInterject();
      interruptChat();
      await new Promise(r => setTimeout(r, 150)); // give streams a beat to abort

      const txt = await promptLine(`${C.cyan}[you] > ${C.reset}`);
      const raw = (txt ?? "").trim();
      if (!raw) {
        (globalThis as any).__log(`interject (user) — (empty)`);
        (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 400;
        (globalThis as any).__PAUSE_INPUT = false;
        try { setTimeout(() => tm.resume(), 400); } catch {}
        return;
      }

      // Send a single high-priority user message; avoid extra nudges that fan out work
      await room.broadcast("User", raw);

      (globalThis as any).__log(`[you] ${raw}`);
      (globalThis as any).__log(`sent interject`);

      // Give the room a moment then release the gate.
      (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 900;
      (globalThis as any).__PAUSE_INPUT = false;
      try { setTimeout(() => tm.resume(), 600); } catch {}
    } catch (e) {
      (globalThis as any).__USER_CONTROL_UNTIL = 0;
      (globalThis as any).__PAUSE_INPUT = false;
      (globalThis as any).__logError(`interject error: ${String(e)}`);
      try { setTimeout(() => tm.resume(), 600); } catch {}
    }
  };

  const startSystemMessage = async () => {
    if (promptActive) return;
    (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 1500;
    (globalThis as any).__PAUSE_INPUT = true;
    try {
      try { tm.pause(); } catch {}
      markUserInterject();
      interruptChat();
      await new Promise(r => setTimeout(r, 120));
      const txt = await promptLine(`${C.cyan}[system] > ${C.reset}`);
      const msg = (txt ?? "").trim();
      if (!msg) {
        (globalThis as any).__log(`system message — (empty)`);
        (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 400;
        (globalThis as any).__PAUSE_INPUT = false;
        try { setTimeout(() => tm.resume(), 400); } catch {}
        return;
      }
      await room.broadcast("System", msg);
      (globalThis as any).__log(`sent system message`);
      (globalThis as any).__USER_CONTROL_UNTIL = Date.now() + 700;
      (globalThis as any).__PAUSE_INPUT = false;
      try { setTimeout(() => tm.resume(), 600); } catch {}
    } catch (e) {
      (globalThis as any).__USER_CONTROL_UNTIL = 0;
      (globalThis as any).__PAUSE_INPUT = false;
      (globalThis as any).__logError(`system message error: ${String(e)}`);
      try { setTimeout(() => tm.resume(), 600); } catch {}
    }
  };

  // --- Single key handler
  function onKey(buf: Buffer) {
    if (promptActive) return; // ignore while prompting
    const s = buf.toString("utf8");
    if (s === "\u0003") { // Ctrl+C
      process.exit(0);
    }
    if (s.length !== 1) return;
    const ch = s;
    if (ch === "q") process.exit(0);
    if (ch === "i") void startInterject();
    if (ch === "s") void startSystemMessage();
  }

  // Attach key handler in interactive mode
  if (INTERACTIVE && process.stdin.isTTY) {
    attachKeys(onKey);
    // start a simple floating banner that scrolls with output
    startBanner();
    process.stdout.on("resize", () => { /* no special redraw needed now */ });
  }
}

app().catch((e) => {
  if (INTERACTIVE) { process.stdout.write(CSI.show); }
  (globalThis as any).__logError(`App crashed: ${String(e)}`);
  process.exit(1);
});