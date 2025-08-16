// test/backpressure-run-throws.test.ts
import { test, expect } from "bun:test";
import { TransportGate } from "../src/core/backpressure";
import { sleep } from "./helpers/sleep";

test("TransportGate.run releases the slot even when fn throws", async () => {
  const gate = new TransportGate({ cooldownMs: 0, maxInFlight: 1 });

  // First run holds the slot briefly then throws.
  const p1 = gate.run(async () => {
    await sleep(50);
    throw new Error("boom");
  }).catch(() => { /* swallow */ });

  let started2At = 0;
  const p2 = gate.run(async () => {
    started2At = Date.now();
    return 42;
  });

  const t0 = Date.now();
  await p1;               // should release the slot
  const val = await p2;   // must complete, not hang
  const waited = started2At - t0;

  expect(val).toBe(42);
  // Without proper release, this would either hang or start immediately (< 50ms).
  expect(waited).toBeGreaterThanOrEqual(45);
}, 2000);
