// tests/unit/interactive.fallback.test.ts
import { describe, it, expect } from "bun:test";
import { shInteractive } from "../../src/tools/sandboxed-sh";

describe("interactive fallback path", () => {
  it("either uses session.execInteractive or falls back to engine", async () => {
    // We can only assert it returns a { code } shape here
    const r = await shInteractive("echo hello", { projectDir: process.cwd(), agentSessionId: "t.interactive" });
    expect(typeof r.code).toBe("number");
  });
});
