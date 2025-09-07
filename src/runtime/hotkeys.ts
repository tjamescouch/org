import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream } from "node:tty";
import { Logger } from "../logger";

type HotkeysOpts = {
  stdin: ReadStream;
  onEsc: () => void | Promise<void>;
  onCtrlC?: () => void;                  // optional
  feedback?: NodeJS.WriteStream;         // default: process.stderr
  debug?: boolean;
};

/**
 * Install a low-level hotkey handler (ESC / Ctrl+C) using the 'keypress' API.
 * - Works in Bun and Node.
 * - Prints ACKs to stderr immediately.
 * - Returns an uninstall() function.
 */
export function installHotkeys(opts: HotkeysOpts): () => void {
  const tty = opts.stdin;
  const out = opts.feedback ?? process.stderr;
  const log = (m: string, ...a: any[]) =>
    opts.debug ? Logger.debug(`[hotkeys] ${m}`, ...a) : undefined;

  if (!tty.isTTY) {
    Logger.debug?.("[hotkeys] stdin is not a TTY; hotkeys disabled");
    return () => {};
  }

  // Prepare the stream for keypress events
  try { emitKeypressEvents(tty); } catch { /* ignore */ }
  try { tty.setRawMode?.(true); } catch { /* ignore */ }
  try { tty.resume(); } catch { /* ignore */ }

  let installed = true;

  const onKeypress = async (_: string, key: Key) => {
    if (!installed) return;

    // Ctrl+C
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      log("Ctrl+C");
      try { opts.onCtrlC?.(); } catch {}
      return;
    }

    // Bare ESC (not Alt+ or CSI)
    if (key.name === "escape" || key.sequence === "\u001b") {
      log("ESC");
      try { await Promise.resolve(opts.onEsc()); } catch {}
      return;
    }
  };

  tty.on("keypress", onKeypress);
  Logger.debug?.("[hotkeys] installed (keypress)");

  return () => {
    if (!installed) return;
    installed = false;
    try { tty.off("keypress", onKeypress); } catch {}
    Logger.debug?.("[hotkeys] uninstalled");
  };
}
