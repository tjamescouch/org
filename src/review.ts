import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { withMutedShHeartbeat } from "./tools/sandboxed-sh";

/** Spawn helper that feeds optional stdin (patch bytes) and resolves with exit code + output. */
function sh(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer | string } = {}) {
    return new Promise<{ code: number, stdout: string, stderr: string }>((resolve) => {
        const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
        let so = "", se = "";
        p.stdout.on("data", d => so += String(d));
        p.stderr.on("data", d => se += String(d));
        p.on("close", code => resolve({ code: code ?? -1, stdout: so, stderr: se }));
        if (opts.input != null) { p.stdin.write(opts.input); }
        p.stdin.end();
    });
}

export type ReviewMode = "ask" | "auto" | "never";

export type SafetyCaps = {
    maxFiles: number;        // fail review if changed files exceed
    maxDeletes: number;      // fail if too many deletes
    maxBytes: number;        // fail if patch is too large
    restricted: string[];    // deny if any path matches these globs (prefix match is OK)
};

export const DEFAULT_CAPS: SafetyCaps = {
    maxFiles: 50,
    maxDeletes: 3,
    maxBytes: 200_000,       // 200 KB
    restricted: [".github/", "infra/", "scripts/release/", "Dockerfile", "Dockerfile.*"],
};

export function modeFromEnvOrFlags(f?: string): ReviewMode {
    if (f === "ask" || f === "auto" || f === "never") return f;
    const env = (process.env.ORG_REVIEW ?? "").toLowerCase();
    if (env === "ask" || env === "auto" || env === "never") return env as ReviewMode;
    return process.stdout.isTTY ? "ask" : "never";
}

/** Quick stat of a patch via git’s numstat/summary. */
export async function patchStats(projectDir: string, patchPath: string) {
    const buf = await fsp.readFile(patchPath);
    const check = await sh("git", ["-C", projectDir, "apply", "--check", "--3way", "--whitespace=nowarn"], { input: buf });
    const num = await sh("git", ["-C", projectDir, "apply", "--numstat", "--summary", "--whitespace=nowarn"], { input: buf });
    const lines = num.stdout.trim().split("\n").filter(Boolean);
    let files = 0, deletes = 0;
    const touched: string[] = [];
    for (const ln of lines) {
        // numstat: "added<TAB>deleted<TAB>path"
        const m = ln.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (m) { files++; touched.push(m[3]); continue; }
        const del = ln.match(/^ delete mode /);
        if (del) deletes++;
    }
    const bytes = buf.byteLength;
    return { appliesCleanly: check.code === 0, files, deletes, bytes, touched, buf };
}

/** Return true if any touched path is inside a restricted prefix. */
function touchesRestricted(touched: string[], restricted: string[]) {
    return touched.some(p => restricted.some(prefix => p === prefix || p.startsWith(prefix)));
}

/** Show a colorized pager (delta/diff-so-fancy/less) or print raw patch if no TTY. */
async function showPatch(patchPath: string) {
    if (!process.stdout.isTTY) {
        const txt = await fsp.readFile(patchPath, "utf8");
        process.stdout.write(txt.slice(0, 2000)); // keep CI logs sane
        return;
    }
    // Prefer delta if present; fall back to less -R
    const viewers: Array<{ cmd: string, args: string[] }> = [
        { cmd: "delta", args: [patchPath] },
        { cmd: "diff", args: ["-color=auto", "-u", patchPath] },
        { cmd: "less", args: ["-R", patchPath] },
    ];
    for (const v of viewers) {
        const exists = await sh("bash", ["-lc", `command -v ${v.cmd}`]);
        if (exists.code === 0) {
            await new Promise<void>((res) => {
                const p = spawn(v.cmd, v.args, { stdio: "inherit" });
                p.on("close", () => res());
            });
            return;
        }
    }
    const txt = await fsp.readFile(patchPath, "utf8");
    console.log(txt);
}

/** Minimal y/n prompt without deps. */
async function askYesNo(q: string, def: boolean): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return def;
    process.stdout.write(`${q} ${def ? "[Y/n]" : "[y/N]"} `);
    return await new Promise<boolean>((resolve) => {
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", d => {
            const s = String(d).trim().toLowerCase();
            if (!s) return resolve(def);
            resolve(s === "y" || s === "yes");
        });
    });
}

export type ReviewDecision =
    | { action: "skip"; reason: string }
    | { action: "apply"; commitMsg: string }
    | { action: "reject" };

export async function decideReview(mode: ReviewMode, projectDir: string, patchPath: string, caps: SafetyCaps = DEFAULT_CAPS): Promise<ReviewDecision> {
    const s = await patchStats(projectDir, patchPath);
    if (s.bytes === 0 || s.files === 0) return { action: "skip", reason: "empty patch" };

    const restrictedHit = touchesRestricted(s.touched, caps.restricted);
    const safe =
        s.appliesCleanly &&
        !restrictedHit &&
        s.files <= caps.maxFiles &&
        s.deletes <= caps.maxDeletes &&
        s.bytes <= caps.maxBytes;

    if (mode === "never") return { action: "skip", reason: "review disabled" };
    if (mode === "auto" && safe) return { action: "apply", commitMsg: autoMsg(s) };
    if (mode === "auto" && !safe) {
        console.log(`Patch NOT auto-safe (files=${s.files}, deletes=${s.deletes}, bytes=${s.bytes}, restricted=${restrictedHit}). Showing review.`);
    }

    let ok = false;
    // ask: show patch, then confirm
    await withMutedShHeartbeat(async () => {
        const view = await askYesNo("View patch?", true);
        if (!view) {
            return;
        }
        await showPatch(patchPath);
        ok = await askYesNo("Apply this patch?", false);
    });

    return ok ? { action: "apply", commitMsg: autoMsg(s) } : { action: "reject" };
}

function autoMsg(s: { files: number }) {
    return `agent batch: apply ${s.files} file(s)`;
}

export async function applyPatch(projectDir: string, patchPath: string, commitMsg: string) {
    const buf = await fsp.readFile(patchPath);
    // double-check
    const chk = await sh("git", ["-C", projectDir, "apply", "--check", "--3way", "--whitespace=nowarn"], { input: buf });
    if (chk.code !== 0) throw new Error(`Patch does not apply cleanly:\n${chk.stderr || chk.stdout}`);

    const ap = await sh("git", ["-C", projectDir, "apply", "--index", "--3way", "--whitespace=nowarn"], { input: buf });
    if (ap.code !== 0) throw new Error(`git apply failed:\n${ap.stderr || ap.stdout}`);

    const co = await sh("git", ["-C", projectDir, "commit", "-m", commitMsg]);
    if (co.code !== 0) throw new Error(`git commit failed:\n${co.stderr || co.stdout}`);
}
