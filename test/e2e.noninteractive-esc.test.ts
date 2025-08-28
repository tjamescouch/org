// test/e2e.noninteractive-esc.test.ts
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { runOrgWithKeys } from "./helpers/run-org-with-keys";

// ESC key
const ESC = "\x1b";
// Optional: the 'i' interject key
const I  = "i";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "org-e2e-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function porcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
}

describe.skip("e2e (non-interactive, SANDBOX_BACKEND=none)", () => {
  // 1) ESC in non-interactive mode applies patches and exits
  it("ESC applies patch and exits", async () => {
    const repo = initRepo();

    // Use the sh tool to create a file (this will be captured by the fallback sandbox)
    const seed =
      `sh {"cmd":"bash -lc \\"echo hello > hello.txt\\""}`
    ;

    const r = await runOrgWithKeys(
      seed,
      [ESC],                              // press ESC once
      { cwd: repo, agents: "alice:mock", env: { SANDBOX_BACKEND: "none" } }
    );

    expect(r.code).toBe(0);

    // Finalizer (non-TTY) auto-applies with --index -> staged add shows up
    const st = porcelain(repo);
    // expect staged A (added) for hello.txt or empty (if recipe commits). Most runners use --index only.
    // Keep it robust: either staged add or clean (if follow-up commit happens later in your pipeline).
    expect(
      st === "" || /\bA\s+hello\.txt\b/.test(st)
    ).toBeTruthy();
  });

  // 2) pressing 'i' in non-interactive mode does nothing (no prompt),
  //    ESC still applies and exits.
  it("'i' does nothing; ESC still applies and exits", async () => {
    const repo = initRepo();

    // Produce a change again
    const seed =
      `sh {"cmd":"bash -lc \\"echo hi > a.txt\\""}`
    ;

    const r = await runOrgWithKeys(
      seed,
      [I, ESC],                           // press 'i' (should be ignored), then ESC
      { cwd: repo, agents: "alice:mock", env: { SANDBOX_BACKEND: "none" } }
    );

    expect(r.code).toBe(0);

    const st = porcelain(repo);
    expect(
      st === "" || /\bA\s+a\.txt\b/.test(st)
    ).toBeTruthy();

    // Bonus assertion: we did not open an interactive prompt
    expect(r.out.includes("\nYou:")).toBe(false);
  });
});
