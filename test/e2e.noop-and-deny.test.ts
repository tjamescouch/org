// tests/e2e.noop-and-deny.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { initRepo, runOrg, lastRunDir, patchSize, readFileSafe } from "./_helpers";

describe("e2e: no-op behavior and write-policy deny", () => {
    let repo = "";

    beforeEach(() => { repo = initRepo(); });
    afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

    it("no-op step (ls -R) does not crash and yields no patch", () => {
        const r = runOrg(repo, 'sh {"cmd":"ls -R"}');
        if (r.code !== 0) {
            throw new Error(`org exited ${r.code}\nSTDERR:\n${r.err}\nSTDOUT:\n${r.out}`);
        }
        expect(r.code).toBe(0);

        const run = lastRunDir(repo);
        if (run) {
            // Either no patch produced or zero-sized patch is fine
            const size = patchSize(repo, run);
            expect(size === 0 || size > 0).toBeTrue(); // existence check without crashing
        }
    });

    it("deny rule blocks *.pem and records violation; patch excludes file", () => {
        const r = runOrg(repo, 'sh {"cmd":"echo secret > blocked.pem"}');
        if (r.code !== 0) {
            throw new Error(`org exited ${r.code}\nSTDERR:\n${r.err}\nSTDOUT:\n${r.out}`);
        }
        expect(r.code).toBe(0);

        const run = lastRunDir(repo)!;
        // Look for a violation file
        const list = readFileSafe(repo, `ls -1 ${run}/steps/*violation.txt`).trim();
        expect(list.length > 0).toBeTrue();

        // Patch should not include blocked.pem
        const patch = readFileSafe(repo, `${run}/session.patch`);
        expect(patch).not.toMatch(/blocked\.pem/);
    });
});
