import { describe, test, expect, mock } from "bun:test";
import RandomScheduler from "../../src/scheduler/random-scheduler";
import { Logger } from "../../src/logger";

describe("scheduler external prompt bridge", () => {
  test("uses readUserLine and retains state machine", async () => {
    const info = mock.spy(Logger, "info");
    let called = 0;

    const sched = new RandomScheduler({
      agents: [],
      maxTools: 0,
      onAskUser: async () => undefined,
      projectDir: "/tmp",
      reviewMode: "never",
      promptEnabled: true,
      readUserLine: async () => { called++; return called === 1 ? "hello" : ""; },
      idleSleepMs: 5,
    } as any); // if SchedulerOptions isn't augmented in the test build

    // Kick it once
    await sched.start();
    await sched.stop();

    expect(called).toBeGreaterThan(0);
    const log = info.mock.calls.map(([m]) => String(m)).join("\n");
    // no scheduler-owned banner
    expect(log.includes("user: (scheduler)")).toBe(false);

    info.mockRestore();
  });
});
