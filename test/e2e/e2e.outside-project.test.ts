// tests/e2e.outside-project.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initRepo, sh, lastRunDir, readFileSafe } from "../_helpers";

describe.skip("e2e: running from outside the repo with -C", () => {
  let repo = "";
  let elsewhere = "";

  beforeEach(() => {
    repo = initRepo();
    elsewhere = mkdtempSync(join(tmpdir(), "org-cwd-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("creates patch in the target repo even when invoked from a different cwd", () => {
    const env = { ...process.env, SANDBOX_BACKEND: "none", ORG_REVIEW: "auto" };
    const cmd = `org -C "${repo}" --agents "alice:lmstudio" --max-tools 5 --prompt 'sh {"cmd":"echo hi > top.txt"}'`;
    const { status } = require("node:child_process").spawnSync("bash", ["-lc", cmd], { cwd: elsewhere, stdio: "pipe", env });
    expect(status).toBe(0);

    const run = lastRunDir(repo)!;
    const patch = readFileSafe(repo, `${run}/session.patch`);
    expect(patch).toMatch(/^diff --git a\/top\.txt b\/top\.txt/m);
    expect(patch).toContain("+hi");
  });
});
