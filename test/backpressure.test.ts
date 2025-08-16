import { describe, test, expect } from "bun:test";
import { TransportGate, delay } from "../src/core/backpressure";

describe("TransportGate", () => {
  test("enforces single-flight", async () => {
    const gate = new TransportGate({ cooldownMs: 0, maxInFlight: 1 });
    let concurrent = 0;
    let peak = 0;

    const job = async () => {
      return gate.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await delay(20);
        concurrent--;
        return 1;
      });
    };

    const results = await Promise.all([job(), job(), job()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(3);
    expect(peak).toBe(1);
  });

  test("respects cooldown between flights", async () => {
    const gate = new TransportGate({ cooldownMs: 30, maxInFlight: 1 });
    const t0 = Date.now();
    await Promise.all([
      gate.run(async () => {}),
      gate.run(async () => {}),
    ]);
    const elapsed = Date.now() - t0;
    // At least ~30ms due to cooldown (allow a little slack for CI)
    expect(elapsed >= 25).toBe(true);
  });

  test("acquire/release works directly", async () => {
    const gate = new TransportGate({ cooldownMs: 0, maxInFlight: 1 });
    const release = await gate.acquire();
    expect(typeof release).toBe("function");
    release();
  });
});

