// src/review/finalize-run.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { C, Logger } from "../logger";
import { withCookedTTY } from "../input/tty-controller";
import type { RoundRobinScheduler } from "../scheduler";
import { ReviewManager } from "../scheduler/review-manager";

async function listRecentSessionPatches(projectDir: string, minutes = 120): Promise<string[]> {
  const root = path.join(projectDir, ".org");
  const candidates = ["last-session.patch"]; // single, canonical patch
  const out: string[] = [];
  const now = Date.now();
  for (const name of candidates) {
    const p = path.join(root, name);
    try {
      const st = await fsp.stat(p);
      if (st.isFile() && (now - st.mtimeMs) <= minutes * 60_000) out.push(p);
    } catch {}
  }
  return out;
}

function hasBin(bin: string): boolean {
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function spawnPager(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 0));
  });
}

async function showPatch(projectDir: string, patchPath: string) {
  const delta = hasBin("delta");
  if (delta) await spawnPager("delta", ["--24-bit-color=never", patchPath], projectDir);
  else       await spawnPager("less",  ["-R", patchPath],         projectDir);
}

export async function finalizeRun(
  _scheduler: RoundRobinScheduler,
  _reviewManager: ReviewManager,
  projectDir: string,
  reviewMode: "ask" | "auto" | "never"
) {
  // In container-first mode we do not apply patches here.
  const patches = await listRecentSessionPatches(projectDir, 240);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }
  if (reviewMode === "never") {
    Logger.info(`Patch ready: ${patches[0]}`);
    return;
  }
  Logger.info(`Patch ready: ${patches[0]}`);
  await withCookedTTY(async () => { await showPatch(projectDir, patches[0]); });
  Logger.info("Container mode: skipping in-process apply; use host patch-apply.");
}
