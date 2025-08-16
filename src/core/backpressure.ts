// src/core/backpressure.ts
// A small single-flight gate with optional cooldown used to serialize
// outbound transport calls (model -> provider) and avoid stampedes.

import { ChannelLock } from "./channel-lock";

export interface GateOptions {
  /** Minimum delay between completing one flight and allowing the next (ms). Default: 150ms */
  cooldownMs?: number;
  /** Max concurrent flights. Default: 1 (single-flight) */
  maxInFlight?: number;
}

/** Lightweight sleep that respects an AbortSignal if provided. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }
  });
}

/**
 * TransportGate provides:
 * - Single-flight (or configurable concurrency) control
 * - Cooldown between flights to give the upstream a breather
 * - A simple run() helper that acquires/releases automatically
 */
export class TransportGate {
  private inFlight = 0;
  private readonly maxInFlight: number;
  private lastRelease = 0;
  private readonly cooldownMs: number;
  private readonly lock = new ChannelLock(); // ensures atomic check+increment

  constructor(opts?: GateOptions) {
    this.maxInFlight = Math.max(1, opts?.maxInFlight ?? 1);
    this.cooldownMs = Math.max(0, opts?.cooldownMs ?? 150);
  }

  /** Acquire a flight slot; returns a release() you MUST call. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }

      // Serialize the check-and-increment to avoid the TOCTOU race
      const unlock = await this.lock.waitForLock();
      let granted = false;
      try {
        const now = Date.now();
        const underLimit = this.inFlight < this.maxInFlight;
        const cooledDown = now - this.lastRelease >= this.cooldownMs;
        if (underLimit && (this.maxInFlight > 1 || cooledDown)) {
          this.inFlight++;
          granted = true;
        }
      } finally {
        unlock();
      }

      if (granted) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // Updates here need not be locked: acquisition is serialized.
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.lastRelease = Date.now();
        };
      }

      await delay(15, signal); // back off before retry
    }
  }

  /** Run an async function under the gate. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** A default singleton gate that most callers can share. */
export const transportGate = new TransportGate({ cooldownMs: 150, maxInFlight: 1 });
