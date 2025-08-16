// test/channel-lock.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Adjust this import if your file is named differently
import { ChannelLock } from "../src/core/channel-lock";
// If your logger exports differently, tweak this import:
import { Logger } from "../src/ui/logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ChannelLock", () => {
  const oldDeadlock = process.env.LOCK_DEADLOCK_MS;
  const oldLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    // keep logs quiet but available
    process.env.LOG_LEVEL = "DEBUG";
  });

  afterEach(() => {
    if (oldDeadlock !== undefined) process.env.LOCK_DEADLOCK_MS = oldDeadlock;
    else delete process.env.LOCK_DEADLOCK_MS;

    if (oldLogLevel !== undefined) process.env.LOG_LEVEL = oldLogLevel;
    else delete process.env.LOG_LEVEL;
  });

  test("grants immediately when unlocked; FIFO ordering for queued waiters", async () => {
    const lock = new ChannelLock();

    const events: string[] = [];

    const releaseA = await lock.waitForLock();
    events.push("A-acquired");

    const pB = lock.waitForLock().then((r) => {
      events.push("B-acquired");
      return r;
    });
    const pC = lock.waitForLock().then((r) => {
      events.push("C-acquired");
      return r;
    });

    // nothing else should be granted yet
    await sleep(10);
    expect(events).toEqual(["A-acquired"]);

    // release A → B should get the lock first, then C
    releaseA();

    const releaseB = await pB;
    expect(events).toEqual(["A-acquired", "B-acquired"]);

    releaseB();

    const releaseC = await pC;
    expect(events).toEqual(["A-acquired", "B-acquired", "C-acquired"]);

    // clean up
    releaseC();
  });

  test("handoff happens on a microtask (not synchronously)", async () => {
    const lock = new ChannelLock();

    const releaseA = await lock.waitForLock();

    let gotB = false;
    const pB = lock.waitForLock().then((r) => {
      gotB = true;
      return r;
    });

    // releasing should not immediately flip gotB in the same sync turn
    releaseA();
    expect(gotB).toBe(false);

    // now await B's grant
    const releaseB = await pB;
    expect(gotB).toBe(true);

    releaseB();
  });

  test("timeout rejects waiter and does not block queue", async () => {
    const lock = new ChannelLock();

    const releaseA = await lock.waitForLock();

    // This one will time out while A is holding the lock
    let timedOut = false;
    const pTimeout = lock
      .waitForLock(25)
      .then(() => {
        throw new Error("should have timed out");
      })
      .catch((e) => {
        timedOut = /timeout/i.test(String(e?.message));
      });

    // Another waiter behind the timeout
    const pB = lock.waitForLock();

    await pTimeout;
    expect(timedOut).toBe(true);

    // When A releases, B should still get the lock
    releaseA();
    const releaseB = await pB;
    expect(typeof releaseB).toBe("function");
    releaseB();
  });

  test("deadlock breaker forcibly releases and rotates queue (B ↔ C)", async () => {
    // Make the deadlock threshold tiny; the interval still ticks each 1s,
    // so the test will run ~1.1–1.2s.
    process.env.LOCK_DEADLOCK_MS = "10";
    const lock = new ChannelLock();

    // Capture [DEADLOCK] warning
    const warnLogs: string[] = [];
    const oldWarn = (Logger as any).warn;
    (Logger as any).warn = (msg: any) => warnLogs.push(String(msg));

    // A acquires and never releases
    await lock.waitForLock();

    const order: string[] = [];
    const pB = lock.waitForLock().then((r) => {
      order.push("B");
      return r;
    });
    const pC = lock.waitForLock().then((r) => {
      order.push("C");
      return r;
    });

    // Wait for the watchdog interval (~1s) to trip the forced release
    await sleep(1200);

    // After deadlock handling, head is rotated to tail, so C is granted first
    expect(order[0]).toBe("C");
    expect(warnLogs.some((s) => s.includes("[DEADLOCK]"))).toBe(true);

    // complete the rotated sequence C then B
    const releaseFirst = order[0] === "C" ? await pC : await pB;
    releaseFirst();
    const releaseSecond = order[0] === "C" ? await pB : await pC;
    releaseSecond();

    // restore logger
    (Logger as any).warn = oldWarn;
  });

  test("release is idempotent (double release does nothing extra)", async () => {
    const lock = new ChannelLock();

    const releaseA = await lock.waitForLock();
    const pB = lock.waitForLock();

    // double release A
    releaseA();
    releaseA();

    const releaseB = await pB;
    // double release B
    releaseB();
    releaseB();

    // Now a new waiter should get in immediately
    const releaseC = await lock.waitForLock();
    releaseC();
  });
});
