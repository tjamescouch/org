// test/e2e.interactive-interject.test.ts
import { mkdtempSync } from "fs";
import { writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { runOrgWithKeys } from "./helpers/run-org-with-keys";

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "org-interject-"));
  execFileSync("git", ["init"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# interject\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("interactive interjection hotkey", () => {
  it("pressing 'i' opens the interactive prompt and sends the text", async () => {
    const repo = mkRepo();

    const env = {
      ...process.env,
      ORG_PAGER: "cat",
      SANDBOX_BACKEND: "none",
    };

    // Start org in interactive TTY with the mock agent.
    const args = ["-C", repo, "--agents", "alice:mock", "--max-tools", "0", "--review", "ask"];

    const r = await runOrgWithKeys(repo, args, [
      { delay: 300, keys: "i" },              // open interjection
      { delay: 50, keys: "hello from test\n" }, // type something and submit
      { delay: 300, keys: "\x1b" },           // ESC to exit cleanly
    ], env);

    // The prompt should have been visible
    expect(r.out).toContain("You:");
    // And our text should have been sent (mock agent echoes/responds)
    expect(r.out).toMatch(/hello from test/i);
    expect(r.code).toBe(0);
  });
});
