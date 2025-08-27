// src/review/finalize-run.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { C, Logger } from "../logger";
import { withCookedTTY } from "../input/tty-guard";
import { sandboxMangers } from "../sandbox/session";
import type { RoundRobinScheduler } from "../scheduler";
import { ReviewManager } from "../scheduler/review-manager";

async function listRecentSessionPatches(projectDir: string, minutes = 120): Promise<string[]> {
  const root = path.join(projectDir, ".org", "runs");
  const out: string[] = [];
  try {
    const entries = await fsp.readdir(root);
    const cutoff = Date.now() - minutes * 60_000;
    for (const d of entries) {
      const patch = path.join(root, d, "session.patch");
      try {
        const st = await fsp.stat(patch);
        if (st.isFile() && st.size > 0 && st.mtimeMs >= cutoff) out.push(patch);
      } catch {}
    }
  } catch {}
  // newest last
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

async function openPager(filePath: string) {
  await withCookedTTY(async () => {
    await new Promise<void>((resolve) => {
      const pager = process.env.ORG_PAGER || "delta -s || less -R || cat";
      const p = spawn("sh", ["-lc", `${pager} ${JSON.stringify(filePath)}`], { stdio: "inherit" });
      p.on("exit", () => resolve());
    });
  });
}

async function askYesNo(prompt: string): Promise<boolean> {
  const rl = await import("node:readline");
  return await new Promise<boolean>((resolve) => {
    const rli = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rli.question(`${prompt} `, (ans) => {
      rli.close();
      const a = String(ans || "").trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

function applyPatch(projectDir: string, patchPath: string) {
  execFileSync("git", ["-C", projectDir, "apply", "--index", patchPath], { stdio: "inherit" });
}

export async function finalizeRun(
  scheduler: RoundRobinScheduler,
  reviewManager: ReviewManager,
  projectDir: string,
  reviewMode: "ask" | "auto" | "never"
) {
  Logger.info(C.magenta('\nFinalizing run...\n'));
  try { await scheduler?.drain?.(); } catch {}
  try { await reviewManager.finalizeAndReview(); } catch {}
  try { await (sandboxMangers as any)?.finalizeAll?.(); } catch {}
  try { scheduler?.stop?.(); } catch {}

  const patches = await listRecentSessionPatches(projectDir, 120);
  if (patches.length === 0) {
    Logger.info("No patch produced.");
    return;
  }

  const isTTY = process.stdout.isTTY;

  for (const patch of patches) {
    Logger.info(`Patch ready: ${patch}`);

    if (reviewMode === "never") continue;

    if (reviewMode === "auto" || !isTTY) {
      try {
        applyPatch(projectDir, patch);
        Logger.info("Patch auto-applied.");
      } catch (e: any) {
        Logger.error("Auto-apply failed:", e?.message || e);
        Logger.info(`Manual apply: git -C ${projectDir} apply --index ${patch}`);
      }
      continue;
    }

    await openPager(patch);
    const yes = await askYesNo("Apply this patch? [y/N]");
    if (yes) {
      try {
        applyPatch(projectDir, patch);
        Logger.info("Patch applied.");
      } catch (e: any) {
        Logger.error("Apply failed:", e?.message || e);
        Logger.info(`Manual apply: git -C ${projectDir} apply --index ${patch}`);
      }
    } else {
      Logger.info("Patch NOT applied.");
    }
  }
}
