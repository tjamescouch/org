// tests/e2e.sandbox-none.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { initRepo, runOrg, lastRunDir, readFileSafe } from "./_helpers";

describe("e2e: sandbox NONE fallback still works", () => {
    let repo = "";

    beforeEach(() => { repo = initRepo(); });
    afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

    it("produces a patch under SANDBOX_BACKEND=none", () => {
        const r = runOrg(repo, 'sh {"cmd":"echo ok > file.txt"}', { SANDBOX_BACKEND: "none" });
        if (r.code !== 0) {
            throw new Error(`org exited ${r.code}\nSTDERR:\n${r.err}\nSTDOUT:\n${r.out}`);
        }
        expect(r.code).toBe(0);

        const run = lastRunDir(repo)!;
        const patch = readFileSafe(repo, `${run}/session.patch`);
        expect(patch).toMatch(/^diff --git a\/file\.txt b\/file\.txt/m);
        expect(patch).toContain("+ok");
    });
});
