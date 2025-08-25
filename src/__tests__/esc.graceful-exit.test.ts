import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// --- Mock the optional sandbox finalizer (must be mocked BEFORE importing the controller) ---
const finalizeSpy = mock.fn(async () => {});
mock.module("../tools/sandboxed-sh", () => ({
  finalizeAllSandboxes: finalizeSpy,
}));

// Now import the controller under test
const { default: InputController } = await import("../controller");

// Common fake scheduler with the methods controller might call
function makeScheduler() {
  return {
    stop: mock.fn(() => {}),
    drain: mock.fn(async () => {}),
    stopDraining: mock.fn(() => {}),
    isDraining: mock.fn(() => false),
    handleUserInterjection: mock.fn(() => {}),
  };
}

// We stub process.exit so tests don't kill the runner.
let originalExit = process.exit;
let exitCode: number | undefined;

beforeEach(() => {
  exitCode = undefined;
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    // DO NOT actually exit; just record
  };
  finalizeSpy.mockClear();
});

afterEach(() => {
  (process as any).exit = originalExit;
  // Clean up any keypress listeners left by the controller
  process.stdin.removeAllListeners("keypress");
});

async function flushMicrotasks(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("ESC graceful shutdown path", () => {
  it("ESC calls scheduler.stop(), invokes sandbox finalizer (when present), and exits 0", async () => {
    const sched = makeScheduler();
    const ic = new InputController(); // installs key listener in constructor
    ic.attachScheduler(sched as any);

    // Simulate pressing ESC
    process.stdin.emit("keypress", "", { name: "escape" });

    // Allow the async finalizer path to run
    await flushMicrotasks(20);

    // Assertions
    expect(sched.stop).toHaveBeenCalledTimes(1);     // scheduler.stop() MUST be called
    expect(finalizeSpy).toHaveBeenCalledTimes(1);    // optional sandbox finalizer invoked
    expect(exitCode).toBe(0);                        // graceful exit
  });

  it("Ctrl+C is a fast exit: does NOT call sandbox finalizer, exits 130", async () => {
    const sched = makeScheduler();
    const ic = new InputController();
    ic.attachScheduler(sched as any);

    // Simulate Ctrl+C
    process.stdin.emit("keypress", "", { name: "c", ctrl: true });

    // No async finalize here, but give a tick for safety
    await flushMicrotasks(5);

    // Assertions
    expect(finalizeSpy).toHaveBeenCalledTimes(0);    // no finalize on fast path
    expect(exitCode).toBe(130);                      // SIGINT conventional exit code
  });
});
