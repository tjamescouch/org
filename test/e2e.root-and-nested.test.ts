// tests/e2e.root-and-nested.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { initRepo, runOrg, lastRunDir, readFileSafe } from "./_helpers";

describe.todo("e2e: patch generation (root & nested)", () => {
    let repo = "";

    beforeEach(() => { repo = initRepo(); });
    afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

    it("root-level file produces a patch", () => {
        const r = runOrg(repo, 'sh {"cmd":"echo hello > hello-root.txt"}');
        if (r.code !== 0) {
            throw new Error(`org exited ${r.code}\nSTDERR:\n${r.err}\nSTDOUT:\n${r.out}`);
        }
        expect(r.code).toBe(0);

        const run = lastRunDir(repo);
        expect(run).toBeTruthy();
        const patch = readFileSafe(repo, `${run}/session.patch`);
        // Expect prefixed headers (or adjust if you chose no-prefix everywhere)
        expect(patch).toMatch(/^diff --git a\/hello-root\.txt b\/hello-root\.txt/m);
        expect(patch).toContain("+hello");
    });

    it("nested file produces a patch", () => {
        const r = runOrg(repo, 'sh {"cmd":"mkdir -p a && echo hi > a/nested.txt"}');
        if (r.code !== 0) {
            throw new Error(`org exited ${r.code}\nSTDERR:\n${r.err}\nSTDOUT:\n${r.out}`);
        }
        expect(r.code).toBe(0);

        const run = lastRunDir(repo)!;
        const patch = readFileSafe(repo, `${run}/session.patch`);
        expect(patch).toMatch(/^diff --git a\/a\/nested\.txt b\/a\/nested\.txt/m);
        expect(patch).toContain("+hi");
    });
});
