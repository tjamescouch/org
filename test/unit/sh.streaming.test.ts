// tests/unit/sh.streaming.test.ts
import { describe, it, expect } from "bun:test";
import { sandboxedSh, withMutedShHeartbeat } from "../../src/tools/sandboxed-sh";

describe("sandboxedSh streaming/basic capture", () => {
  it("captures progressive stdout and returns final buffer", async () => {
    // simple portable loop: prints 3 lines with small sleeps
    const cmd = `bash -lc 'for i in 1 2 3; do echo line-$i; sleep 0.1; done'`;
    const r = await withMutedShHeartbeat(() =>
      sandboxedSh({ cmd }, { projectDir: process.cwd(), agentSessionId: "t.streaming" })
    );
    expect(r.ok).toBe(true);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["line-1","line-2","line-3"]);
  });
});
