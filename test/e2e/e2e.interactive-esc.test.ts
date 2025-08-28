// test/e2e.interactive-esc.test.ts
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { runOrgWithKeys } from "../helpers/run-org-with-keys";

// Create a tiny git repo that `org` can work inside
function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "org-interactive-"));
  execFileSync("git", ["init"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function writeRecentSessionPatch(repo: string) {
  // Finalize step looks for recent files under .org/runs/*/session.patch
  const runDir = join(repo, ".org", "runs", "manual");
  mkdirSync(runDir, { recursive: true });
  // A minimal valid git patch that adds hello.txt with one line
  const patch = `diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
hello
`;
  writeFileSync(join(runDir, "session.patch"), patch);
}

describe.skip("interactive ESC behavior", () => {
  it("ESC closes with no prompt when there is no patch", async () => {
    const repo = mkRepo();

    const env = {
      ...process.env,
      ORG_PAGER: "cat",
      SANDBOX_BACKEND: "none",
    };

    // --review ask, interactive (TTY), but no patch exists
    const args = ["-C", repo, "--agents", "alice:mock", "--max-tools", "0", "--review", "ask"];
    const r = await runOrgWithKeys(repo, args, [
      // Let app boot, then ESC
      { delay: 400, keys: "\x1b" }, // ESC
    ], env);

    expect(r.code).toBe(0);
    // No pager prompt text; no "Apply this patch?" question
    expect(r.out).not.toContain("Apply this patch?"); 
  });

  it("ESC prompts in --review ask when a recent session.patch exists, applies only on 'y'", async () => {
    const repo = mkRepo();
    writeRecentSessionPatch(repo);

    const env = {
      ...process.env,
      ORG_PAGER: "cat",
      SANDBOX_BACKEND: "none",
    };

    // We expect to be prompted, so send ESC then 'y\n'
    const args = ["-C", repo, "--agents", "alice:mock", "--max-tools", "0", "--review", "ask"];
    const r = await runOrgWithKeys(repo, args, [
      { delay: 400, keys: "\x1b" },  // ESC to trigger finalize
      { delay: 200, keys: "y\n" },   // accept
    ], env);

    expect(r.code).toBe(0);
    expect(r.out).toContain("Apply this patch?"); // prompt showed up

    // hello.txt should now exist after git apply --index
    const added = existsSync(join(repo, "hello.txt"));
    expect(added).toBe(true);
  });
});
