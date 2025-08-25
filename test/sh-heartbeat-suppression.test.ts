// tests/sh.heartbeat.suppression.test.ts
import { describe, it, expect } from "bun:test";

// Adjust import to your sh runner once it's wired to a shared `UIBusy` flag
// import { runSh } from "../src/tools/sh";
// import { UIBusy } from "../src/ui/busy-flag";

describe.todo("heartbeat suppression while patch UI or confirmation banner is visible", () => {
  it("does not emit heartbeat dots when UIBusy=true", async () => {
    // Pseudocode sketch:
    // UIBusy.set(true);
    // const res = await runSh("sleep 0.3; echo hi", { idleHeartbeatMs: 50 });
    // Assert on captured stderr: no dots were produced while UIBusy was true
    // UIBusy.set(false);
    expect(true).toBe(true);
  });
});
