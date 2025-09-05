import { Logger } from "../../src/logger";

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const intervalMs = opts.intervalMs ?? 10;

  const start = Date.now();
  let lastErr: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      if (await cond()) return;
    } catch (e) {
      lastErr = e;
      // we allow the predicate to throw during transient states
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  const err = new Error(
    `waitFor timed out after ${timeoutMs}ms` +
    (lastErr ? ` (last error: ${(lastErr as Error)?.message ?? String(lastErr)})` : "")
  );
  Logger.error(err);
  throw err;
}