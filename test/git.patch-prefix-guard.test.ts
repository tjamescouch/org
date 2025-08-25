// tests/git.patch-prefix-guard.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8");
}

describe("git diff emits a/b prefixes for top-level files (regression guard)", () => {
  let wd = "";

  beforeEach(() => {
    wd = mkdtempSync(join(tmpdir(), "org-diff-prefix-"));
    sh(wd, "git init -q");
    sh(wd, 'git config user.email noreply@example.com');
    sh(wd, 'git config user.name org');
    // keep the repo clean
    writeFileSync(join(wd, ".gitignore"), "\n");
    sh(wd, "git add -A && git commit -m init -q");
  });

  afterEach(() => {
    rmSync(wd, { recursive: true, force: true });
  });

  it("always contains a/b prefixes even if repo tries to force no-prefix", () => {
    // Simulate a misconfigured repo that tries to turn prefixes off.
    sh(wd, "git config diff.noprefix true");

    writeFileSync(join(wd, "hello-top.txt"), "Hello\n");
    sh(wd, "git add -A && git commit -m add-top -q");

    const base = sh(wd, "git rev-parse HEAD~1").trim();

    // Correct ordering: all -c flags BEFORE 'diff'
    const patch = sh(
      wd,
      `git -c diff.noprefix=false -c color.ui=false -c core.pager=cat diff --binary --no-ext-diff ${base} HEAD`
    );

    expect(patch).toMatch(/^diff --git a\/hello-top\.txt b\/hello-top\.txt/m);
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("+Hello");
  });

  it("demonstrates the failure mode without the guard (no a/b prefixes)", () => {
    // IMPORTANT: put the repo into the 'bad' state first
    sh(wd, "git config diff.noprefix true");

    writeFileSync(join(wd, "oops.txt"), "Oops\n");
    sh(wd, "git add -A && git commit -m add-oops -q");

    const base = sh(wd, "git rev-parse HEAD~1").trim();

    // No '-c diff.noprefix=false' override here on purpose
    // (still keep the other -c flags before 'diff')
    const badPatch = sh(
      wd,
      `git -c color.ui=false -c core.pager=cat diff --binary --no-ext-diff ${base} HEAD`
    );

    // Broken form we see without the guard (no a/ b/ prefixes)
    expect(badPatch).toMatch(/^diff --git oops\.txt oops\.txt/m);
    expect(badPatch).not.toMatch(/^diff --git a\/oops\.txt b\/oops\.txt/m);
  });
});
