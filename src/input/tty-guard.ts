import { InputController } from "./controller";
import { Logger } from "../logger";

// Install once
let installed = false;

export function installTtyGuard() {
  if (installed) return;
  installed = true;

  const restore = () => {
    try { InputController.setRawMode(false); } catch {}
    try { InputController.enableKeys?.(); } catch {}
  };

  process.on("exit", restore);
  process.on("SIGINT", () => { restore(); process.exit(130); });
  process.on("SIGTERM", () => { restore(); process.exit(143); });
  process.on("uncaughtException", (err) => { restore(); Logger.error?.(err); process.exit(1); });
  process.on("unhandledRejection", (reason: any) => { restore(); Logger.error?.(reason); process.exit(1); });
}

/**
 * Run a block with the terminal in *cooked* mode, then restore.
 * We snapshot the prior raw state using InputController.isRawMode if available,
 * otherwise fall back to process.stdin.isRaw.
 */
export async function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
  const prevRaw =
    (InputController as any).isRawMode?.() ??
    (process.stdin as any)?.isRaw ??
    false;

  try {
    InputController.disableKeys?.();
    if (prevRaw) InputController.setRawMode(false);
    return await fn();
  } finally {
    try { InputController.setRawMode(!!prevRaw); } catch {}
    try { InputController.enableKeys?.(); } catch {}
  }
}
