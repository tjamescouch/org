// input/tty.ts (or directly in app.ts)
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

type Handlers = {
  onEsc: () => Promise<void> | void;
  onCtrlC?: () => void;
};

let rl: readline.Interface | null = null;

export function initInteractiveTty(handlers: Handlers) {
  if (!input.isTTY) return;

  // 1) A single readline editor for the whole run
  rl = readline.createInterface({ input, output, terminal: true, historySize: 50 });

  // 2) Keypress stream (lets us catch bare ESC while still using readline)
  readline.emitKeypressEvents(input, rl);
  input.setRawMode?.(true);
  input.resume();

  // Bare ESC -> graceful shutdown; Ctrl+C -> immediate exit
  input.on("keypress", async (_str, key) => {
    if (!key) return;

    if (key.name === "escape" && !key.ctrl && !key.meta && !key.shift) {
      // arrows, alt+<key>, etc. are parsed as other names; this is just bare ESC
      try { await handlers.onEsc(); } catch {}
      return;
    }
    if (key.ctrl && key.name === "c") {
      handlers.onCtrlC?.();
      // default: immediate
      cleanupTty();
      process.exit(130);
    }
  });

  rl.on("SIGINT", () => {
    handlers.onCtrlC?.();
    cleanupTty();
    process.exit(130);
  });
}

export function cleanupTty() {
  try { input.setRawMode?.(false); } catch {}
  try { rl?.close(); } catch {}
  input.pause();
  rl = null;
}

// Ask the user for a single line (supports editing, arrows, backspace, etc.)
export async function askUserLine(prompt = "You: "): Promise<string> {
  if (!rl) return "";
  return new Promise<string>((resolve) => {
    rl!.setPrompt(prompt);
    rl!.prompt();
    rl!.once("line", (line) => resolve(line));
  });
}

// If you log while a prompt is on the screen, redraw it afterwards.
export function logWithPromptRedraw(msg: string) {
  if (!rl) { console.log(msg); return; }
  output.write(`\n${msg}\n`);
  rl.prompt(true);
}
