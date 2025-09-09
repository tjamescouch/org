import { describe, test, expect } from "bun:test";
import RandomScheduler from "../../src/scheduler/random-scheduler";
import { Logger } from "../../src/logger";
import { spyMethod } from "../helpers/spy";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduler external prompt bridge", () => {
  test("uses readUserLine and retains state machine", async () => {
    // Spy on Logger.info without relying on Bun's mock API.
    const infoSpy = spyMethod(Logger as unknown as { info: (...args: unknown[]) => void }, "info");

    let calls = 0;
    const sched = new RandomScheduler({
      agents: [],
      maxTools: 0,
      onAskUser: async () => undefined, // not used when readUserLine is provided
      projectDir: "/tmp",
      reviewMode: "never",
      promptEnabled: true,
      // Bridge supplies exactly one line, then empty to avoid a tight loop
      readUserLine: async () => {
        calls++;
        return calls === 1 ? "hello" : "";
      },
      idleSleepMs: 5,
    } as any); // local extension in tests to pass readUserLine

    try {
      // Run the scheduler and then stop it; avoid awaiting start() directly to prevent a hang.
      const running = sched.start();
      await wait(20);
      await sched.stop();
      await running;
    } finally {
      infoSpy.restore();
    }

    // Bridge was exercised at least once
    expect(calls).toBeGreaterThan(0);

    // Build a joined string of what Logger.info saw
    const joined = infoSpy.calls
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n");

    // With the bridge, the scheduler must NOT print its own 'You > (scheduler)' banner.
    expect(joined.includes("You > (scheduler)")).toBe(false);
  });
});
