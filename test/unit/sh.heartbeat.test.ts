// tests/unit/sh.heartbeat.test.ts
import { describe, it, expect } from "bun:test";
import { sandboxedSh } from "../../src/tools/sandboxed-sh";
import { captureWrites } from "../_helpers";

describe("heartbeat emits dots on idle", () => {
  it("prints at least one dot for a sleeping command", async () => {
    const { run, done } = captureWrites(process.stderr, () =>
      sandboxedSh(
        { cmd: "bash -lc 'sleep 0.6; echo done'" },
        { projectDir: process.cwd(), agentSessionId: "t.heartbeat", idleHeartbeatMs: 300 }
      )
    );
    const result = await run;
    const err = await done();
    expect(result.ok).toBeTruthy();
    expect(err).toContain("sh: bash -lc 'sleep 0.6; echo done' -> ");
    expect(err).toContain("."); // at least one heartbeat dot
  });
});
