// tests/e2e/cli.anydir.test.ts
import { describe, it, expect } from "bun:test";
import { tempDir, runBin } from "../_helpers";
import path from "path";
import { symlinkSync } from "fs";

describe("org can run from any directory via symlink", () => {
  it("works when invoked from outside repo root", () => {
    const t = tempDir();
    try {
      // make a symlink to repo's org launcher into temp PATH dir
      // adjust path to your real launcher if needed
      const repoOrg = path.resolve("org");
      const link = path.join(t.path, "org");
      symlinkSync(repoOrg, link);
      const r = runBin([link, "--ui", "console", "--prompt", "noop"], { cwd: t.path });
      expect(r.stderr.toString()).not.toMatch(/Module not found .*\/work\/src\/app\.ts/);
    } finally {
      t.cleanup();
    }
  });
});