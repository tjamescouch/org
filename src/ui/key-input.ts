import { Logger } from "../logger";

export interface KeyHandlers {
  onInterject?: () => void;
  onSendSystem?: () => void;
  onQuit?: () => void;
}

export function setupKeyInput(h: KeyHandlers) {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    Logger.debug("key-input: stdin is not a TTY; interactive keys disabled");
    return { close(){} };
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

  try { stdin.setRawMode(true); } catch {}
  stdin.resume();
  stdin.on("data", onData);
  Logger.info("key-input: ready. keys — i:interject, s:system, q:quit, ^C:quit");

  return {
    close() {
      stdin.off("data", onData);
      try { stdin.setRawMode(false); } catch {}
    }
  };
}
