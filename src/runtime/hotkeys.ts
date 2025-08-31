// src/runtime/hotkeys.ts
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
 * Install a low-level raw-byte hotkey handler (ESC / Ctrl+C).
 * - Plays nicely with readline/keypress (they can coexist).
 * - Prints feedback to stderr immediately.
 * - Returns an uninstall() function.
 */
export function installHotkeys(opts: HotkeysOpts): () => void {
  Logger.info("Installing hotkeys 🔥");
  const inTTY = !!opts.stdin.isTTY;
  const out = opts.feedback ?? process.stderr;
  const log = (msg: string, ...a: any[]) =>
    opts.debug ? Logger.debug(`[hotkeys] ${msg}`, ...a) : undefined;

  if (!inTTY) {
    Logger.debug?.("[hotkeys] stdin is not a TTY; hotkeys disabled");
    return () => {};
  }

  Logger.error("🥩 Input in raw mode");
  try { opts.stdin.setRawMode?.(true); } catch { /* ignore */ }
  // Ensure the stream is in flowing mode; without this you won't see 'data' events.
  try { opts.stdin.resume(); } catch { /* ignore */ }

  let escTimer: NodeJS.Timeout | null = null;

  const handleChunk = (chunk: Buffer | string) => {
    // You asked “should I see logs for handleChunk?” — this is it:
    log("handleChunk");

    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    const len = buf.length;
    if (len === 0) return;

    // Ctrl+C (ETX)
    if (buf[0] === 0x03) {
      log("Ctrl+C");
      try { opts.onCtrlC?.(); } finally { /* fall through */ }
      return;
    }

    // ── ESC handling with a tiny debounce ─────────────────────────────────
    // If we see exactly one ESC byte, wait a tick to see if this is part of a CSI / Alt+ combo.
    if (len === 1 && buf[0] === 0x1b) {
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(async () => {
        escTimer = null;
        try {
          out.write("\n⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)\n");
        } catch { /* ignore */ }
        log("ESC (bare)");
        await Promise.resolve(opts.onEsc());
      }, 15); // small hair; feels instant but avoids misfires on arrow keys etc.
      return;
    }

    // If a CSI sequence arrives, cancel the pending bare-ESC
    if (escTimer && len >= 2 && buf[0] === 0x1b && buf[1] === 0x5b /* [ */) {
      clearTimeout(escTimer);
      escTimer = null;
      log("ESC canceled (CSI)");
    }
    // ──────────────────────────────────────────────────────────────────────
  };

  opts.stdin.on("data", handleChunk);
  Logger.debug?.("[hotkeys] installed");

  return () => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    try { opts.stdin.off("data", handleChunk); } catch { /* ignore */ }
    Logger.debug?.("[hotkeys] uninstalled");
  };
}
