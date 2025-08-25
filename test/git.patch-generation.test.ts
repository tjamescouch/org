// tests/git.patch-generation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8");
}

describe("git diff patch generation mirrors sandbox finalize flow", () => {
  let wd = "";

  beforeEach(() => {
    wd = mkdtempSync(join(tmpdir(), "org-patch-"));
    sh(wd, "git init -q");
    sh(wd, "git config user.email noreply@example.com");
    sh(wd, "git config user.name org");
    writeFileSync(join(wd, ".gitignore"), "\n");
    sh(wd, "git add -A && git commit -m init -q");
  });

  afterEach(() => {
    rmSync(wd, { recursive: true, force: true });
  });

  it("generates a patch for a root-level file", () => {
    writeFileSync(join(wd, "hello-root.txt"), "Hello Root\n");
    sh(wd, "git add -A && git commit -m add-root -q");

    const base = sh(wd, "git rev-parse HEAD~1").trim();
    // NOTE: `-c` flags must come BEFORE the subcommand; disable color/pager; keep prefixes a/ and b/
    const patch = sh(
      wd,
      `git -c color.ui=false -c core.pager=cat --no-pager diff --binary --no-ext-diff ${base} HEAD`
    );

    expect(patch).toContain("diff --git a/hello-root.txt b/hello-root.txt");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("+Hello Root");
  });

  it("generates a patch for a nested file", () => {
    sh(wd, "mkdir -p test");
    writeFileSync(join(wd, "test/hello-sub.txt"), "Hello Sub\n");
    sh(wd, "git add -A && git commit -m add-sub -q");

    const base = sh(wd, "git rev-parse HEAD~1").trim();
    // Same flags/order as above; keep prefixes a/ and b/
    const patch = sh(
      wd,
      `git -c color.ui=false -c core.pager=cat --no-pager diff --binary --no-ext-diff ${base} HEAD`
    );

    expect(patch).toContain("diff --git a/test/hello-sub.txt b/test/hello-sub.txt");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("+Hello Sub");
  });
});
