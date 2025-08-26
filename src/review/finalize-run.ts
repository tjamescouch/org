import * as path from "path";
import * as fsp from "fs/promises";
import { withCookedTTY } from "../input/tty-guard";
import { applySessionPatch } from "../cli/apply-patch"; // your robust applier
import { Logger } from "../logger";

export type FinalizeOpts = {
  session: { finalize(): Promise<{ manifestPath: string; patchPath?: string }> };
  projectDir: string;
  reviewMode: "ask" | "auto" | "never";
  isTTY: boolean;
};

/**
 * Finalize the sandbox, then review/apply per reviewMode.
 * - In TTY + 'ask' we open the pager (via withCookedTTY).
 * - In non-TTY or 'auto' we auto-apply if clean & patch exists.
 * - Always prints accepted & rejected file summaries.
 */
export async function finalizeRun(opts: FinalizeOpts) {
  const { session, projectDir, reviewMode, isTTY } = opts;
  const { manifestPath, patchPath } = await session.finalize();

  // summaries
  try {
    const runDir = path.dirname(manifestPath);
    // accepted (status between baseline..HEAD is already inside finalize)
    const accepted = await fsp.readFile(path.join(runDir, "steps/step-0.status.txt")).catch(() => null);
    if (accepted && accepted.toString().trim()) {
      Logger.info("=== Accepted file changes ===");
      Logger.info(accepted.toString().trim());
    } else {
      Logger.info("No accepted file changes.");
    }
    // rejected
    const files = await fsp.readdir(path.join(runDir, "steps")).catch(() => []);
    const vFiles = files.filter(f => f.endsWith(".violation.txt"));
    if (vFiles.length) {
      Logger.info("=== Rejected/violated files ===");
      for (const vf of vFiles) {
        const body = await fsp.readFile(path.join(runDir, "steps", vf), "utf8").catch(() => "");
        if (body.trim()) Logger.info(body.trim());
      }
    }
  } catch {}

  if (!patchPath) {
    Logger.info("No patch produced.");
    return { applied: false, reason: "no-patch" as const };
  }

  if (reviewMode === "never") {
    Logger.info(`Patch written: ${patchPath}`);
    return { applied: false, reason: "review-never" as const };
  }

  if (reviewMode === "ask" && isTTY) {
    // open pager in cooked TTY; your pager lives inside ReviewManager/decideReview
    await withCookedTTY(async () => {
      // if you already have a ReviewManager, call it here instead:
      // await reviewManager.askAndMaybeApply(projectDir, patchPath);
      // Fallback: just show the patch with 'less -R'
      try {
        const { spawn } = await import("child_process");
        await new Promise<void>((resolve) => {
          const p = spawn("sh", ["-lc", `(${process.env.ORG_PAGER || "less -R"}) ${JSON.stringify(patchPath)}`], { stdio: "inherit" });
          p.on("exit", () => resolve());
        });
      } catch {}
    });
    return { applied: false, reason: "review-asked" as const };
  }

  // non-TTY or auto
  try {
    await applySessionPatch(projectDir, patchPath, "org auto-committed changes.");
    Logger.info("Patch auto-applied.");
    return { applied: true as const };
  } catch (e: any) {
    Logger.error("Auto-apply failed:", e?.message || e);
    Logger.info(`You can apply manually: git apply --index ${patchPath}`);
    return { applied: false, reason: "apply-failed" as const };
  }
}
