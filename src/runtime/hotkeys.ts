// src/runtime/hotkeys.ts
// Robust ESC detection while readline owns the TTY (Bun/Node).
// We watch raw bytes on stdin and only treat a *single* ESC (0x1b) as "graceful quit".
// Arrow keys etc. send ESC+[... — we ignore those sequences.

import { stdin as input } from "node:process";

type Handlers = {
  onEsc: () => void | Promise<void>;
  onCtrlC?: () => void | Promise<void>;
};

let installed = false;
let onData: ((buf: Buffer) => void) | null = null;
let escPending = false;
let escTimer: NodeJS.Timeout | null = null;

function cancelEscTimer() {
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  escPending = false;
}

export function initHotkeys(handlers: Handlers) {
  if (!input.isTTY || installed) return;
  installed = true;

  // DO NOT setRawMode here; readline will already do that when prompting.
  // We just piggyback on the raw byte stream while readline is active.

  onData = async (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      // Ctrl+C (0x03) — immediate fast exit hook if you want it
      if (b === 0x03) {
        if (handlers.onCtrlC) await handlers.onCtrlC();
        continue;
      }

      // ESC (0x1b)
      if (b === 0x1b) {
        // Start a short window: if more bytes follow, it's a sequence -> ignore.
        escPending = true;
        cancelEscTimer();
        escTimer = setTimeout(async () => {
          // No extra bytes arrived in time: treat as a lone ESC
          escPending = false;
          escTimer = null;
          await handlers.onEsc();
        }, 40); // 40ms is enough to separate lone ESC from ESC+[ sequences
        continue;
      }

      // Any other byte arriving while ESC is pending cancels the ESC action
      if (escPending) {
        // Typical sequences are ESC '[' ... or ESC 'O' ...
        cancelEscTimer();
      }
    }
  };

  input.on("data", onData);
  input.resume();
}

export function disposeHotkeys() {
  if (!installed) return;
  installed = false;
  cancelEscTimer();
  if (onData) input.off("data", onData);
  onData = null;
  // Do not change raw mode / pause here; readline manages it during prompts.
}
