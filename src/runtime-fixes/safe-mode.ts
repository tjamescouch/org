import { Logger } from "../logger";

const SAFE = process.env.SAFE_MODE === "1";
if (!SAFE) { /* noop */ } else {
  try {
    const desc = Object.getOwnPropertyDescriptor(globalThis as any, "fetch");
    const orig = (globalThis as any).fetch?.bind(globalThis) as typeof fetch | undefined;

    if (!orig || !desc || !(desc.writable || desc.configurable)) {
      Logger.warn("safe-mode: global fetch not swappable on this runtime; continuing without gating.");
    } else {
      const waitForEnter = async () => {
        if (!process.stdout.isTTY || !process.stdin.isTTY) return;
        process.stdout.write("[SAFE] Press Enter to run next step…\n");
        let resolved = false;
        const onData = (buf: Buffer) => {
          if (buf.includes(10) || buf.includes(13)) { // newline
            resolved = true;
            clearInterval(timer);
            process.stdin.off("data", onData);
          }
        };
        const timer = setInterval(() => {
          if (!resolved) process.stdout.write("[waiting for user input…]\n");
        }, 1500);
        process.stdin.resume();
        process.stdin.on("data", onData);
        // Wait until resolved
        await new Promise<void>(r => {
          const check = () => resolved ? r() : setTimeout(check, 25);
          check();
        });
      };

      const gated: typeof fetch = async (...args) => {
        await waitForEnter();
        return orig(...args as any);
      };

      Object.defineProperty(globalThis as any, "fetch", {
        value: gated, configurable: true, writable: true
      });
      Logger.info("safe-mode: fetch gating installed");
    }
  } catch (e: any) {
    Logger.warn("safe-mode: install failed:", e?.message ?? e);
  }
}
