// src/input/passthrough.ts
import { DefaultInput } from "./controller";

/**
 * withPassthrough(fn)
 * Temporarily enables raw passthrough (so ESC and other keys are not captured
 * by our app-level InputController), runs `fn`, then restores the previous mode.
 *
 * - Nest/concurrency-safe: uses a shared depth counter. Multiple overlapping
 *   calls won't fight each other; passthrough is disabled only when the
 *   outer-most call completes.
 */
let depth = 0;

export async function withPassthrough<T>(fn: () => Promise<T> | T): Promise<T> {
  const needEnable = depth++ === 0;
  if (needEnable) {
    try { DefaultInput.setPassthrough(true); } catch { /* fail-soft */ }
  }

  try {
    return await fn();
  } finally {
    if (--depth === 0) {
      try { DefaultInput.setPassthrough(false); } catch { /* fail-soft */ }
    }
  }
}

// Alias, if you prefer longer name at call sites
export const withInputPassthrough = withPassthrough;
