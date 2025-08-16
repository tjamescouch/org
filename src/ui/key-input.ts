import { BrightRedTag, Reset } from "../constants";
import { appendDirect, stamp } from "../core/entity/agent-model";
import { Logger } from "./logger";

export interface KeyHandlers {
  onInterject?: () => void;
  onSendSystem?: () => void;
  onQuit?: () => void;
}

export function setupKeyInput(h: KeyHandlers) {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    Logger.debug("key-input: stdin is not a TTY; interactive keys disabled");
    return { close() { } };
  }

  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
    // CTRL-C
    if (buf.length === 1 && buf[0] === 3) { Logger.info("key-input: ^C"); h.onQuit?.(); return; }
    // Enter (ignored here; safe-mode wrapper handles it)
    if (s === "\r" || s === "\n") return;

    const ch = s.toLowerCase();
    if (ch === "i") { Logger.info("key-input: i (interject)"); h.onInterject?.(); return; }
    if (ch === "s") { Logger.info("key-input: s (send system)"); h.onSendSystem?.(); return; }
    if (ch === "q") { Logger.info("key-input: q (quit)"); h.onQuit?.(); return; }
    // Debug
    Logger.debug("key-input: raw=", JSON.stringify(s));
  };

  try { stdin.setRawMode(true); } catch { }
  stdin.resume();
  stdin.on("data", onData);
  Logger.info("key-input: ready. keys — i:interject, s:system, q:quit, ^C:quit");

  return {
    close() {
      stdin.off("data", onData);
      try { stdin.setRawMode(false); } catch { }
    }
  };
}

// Pause for Enter when safe mode is enabled.  Returns a promise that
// resolves once the user presses Enter.  If stdin is not a TTY this
// resolves immediately.
export function waitForEnter(msg: string): Promise<void> {
  if (process.stdin.isTTY) {
    appendDirect(`${BrightRedTag()} Continue? [y/N] ******* ${msg}${Reset()}`);
    return new Promise((resolve, reject) => {
      process.stdout.write('Continue? [y/N]');
      process.stdin.resume();
      process.stdin.once('data', (data: Buffer) => {
        const s = data.toString("utf8");
        if (s.trim() !== "y") {
          reject();
        } else {
          resolve();
        }
      });
    });
  }
}
