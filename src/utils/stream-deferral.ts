// src/utils/stream-deferral.ts
// Guarantees onStreamStart() runs once and onStreamEnd() runs in finally.
// Use around any "model is chattering" region (streaming, or a synchronous respond()).

export interface StreamHooks {
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
}

/**
 * Wrap any async "streaming" workload so ESC/I deferral works correctly.
 * Calls hooks.onStreamStart() just before work() starts, and hooks.onStreamEnd() in finally.
 */
export async function withStreamDeferral<T>(
  hooks: StreamHooks,
  work: () => Promise<T>
): Promise<T> {
  // Start-of-stream (treat the overall respond call as "chattering")
  hooks.onStreamStart();
  try {
    return await work();
  } finally {
    // End-of-stream always fires, even on rejection or cancellation
    await hooks.onStreamEnd();
  }
}

/**
 * Variant for callback-style token streams.
 * First token triggers onStreamStart() lazily; end() must be called exactly once.
 */
export function makeTokenNotifier(hooks: StreamHooks) {
  let started = false;
  return {
    /** Call this on each token; it will fire onStreamStart() exactly once on the first token. */
    onToken: () => {
      if (!started) {
        started = true;
        hooks.onStreamStart();
      }
    },
    /** Ensure onStreamEnd() is called once when the stream finishes. */
    async end() {
      if (!started) {
        // No tokens ever arrived; treat it as a short/empty stream.
        hooks.onStreamStart();
      }
      await hooks.onStreamEnd();
    },
  };
}
