// src/runtime/hotkeys.ts
import * as readline from "node:readline";
import { stdin as input } from "node:process";

type Handlers = {
  onEsc: () => void | Promise<void>;
  onCtrlC?: () => void | Promise<void>;
};

let installed = false;
let onKey: ((str: string, key: readline.Key) => void) | null = null;

export function initHotkeys(handlers: Handlers) {
  if (!input.isTTY || installed) return;
  installed = true;

  // Generate 'keypress' events
  readline.emitKeypressEvents(input);

  // Raw so we see bare ESC as a single keypress
  try { input.setRawMode?.(true); } catch {}

  onKey = async (_str, key) => {
    if (!key) return;
    if (key.name === "escape" && !key.ctrl && !key.meta && !key.shift) {
      await handlers.onEsc();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (handlers.onCtrlC) await handlers.onCtrlC();
    }
  };

  input.on("keypress", onKey);
  input.resume();
}

export function disposeHotkeys() {
  if (!installed) return;
  installed = false;
  if (onKey) input.removeListener("keypress", onKey);
  onKey = null;
  try { input.setRawMode?.(false); } catch {}
  input.pause();
}
