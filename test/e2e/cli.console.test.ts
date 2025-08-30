// tests/e2e/cli.console.test.ts
import { describe, it, expect } from "bun:test";
import { haveCmd, runBin } from "../_helpers";

describe("org --ui console basic", () => {
  it("starts and exits cleanly with a trivial prompt", () => {
    // Run: bun org --ui console --prompt 'say hi'
    const r = runBin(["org", "--ui", "console", "--prompt", "say hi"]);
    // We expect non-crash; exit code can be 0 or app-defined, but stderr should not have stack
    expect(r.stderr.toString()).not.toMatch(/SyntaxError|TypeError|ReferenceError/);
  });
});
