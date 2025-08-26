// src/scheduler/review-manager.ts
import * as fs from "fs";
import { execFileSync } from "child_process";
import { Logger } from "../logger";
import { finalizeSandbox } from "../tools/sandboxed-sh";
import { modeFromEnvOrFlags, decideReview } from "../review";
import { applySessionPatch } from "../cli/apply-patch";

export class ReviewManager {
  constructor(private projectDir: string, private reviewMode: string) {}

  /**
   * Call this after a tool batch for a specific agent session.
   * It finalizes that sandbox, then runs the selected review flow.
   */
  async afterToolBatch(agentSessionId: string): Promise<void> {
    await this.finalizeOneAndReview(agentSessionId);
  }

  /**
   * Convenience for graceful shutdown: finalize & review any remaining changes
   * for the provided agent session IDs (usually the agent ids).
   */
  async finalizeAndReview(agentSessionIds: string[] = []): Promise<void> {
    for (const id of agentSessionIds) {
      try {
        await this.finalizeOneAndReview(id);
      } catch (e: any) {
        Logger.error(`finalizeAndReview: ${id}:`, e?.message ?? e);
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  private async finalizeOneAndReview(agentSessionId: string): Promise<void> {
    const fin = await finalizeSandbox({ projectDir: this.projectDir, agentSessionId } as any);
    const patchPath = (fin as any)?.patchPath as string | undefined;
    if (!patchPath || !fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) {
      return;
    }

    const mode = modeFromEnvOrFlags(this.reviewMode); // "ask" | "auto" | "never"
    const decision = await decideReview(mode, this.projectDir, patchPath);

    if (decision.action === "apply") {
      try {
        await applySessionPatch(this.projectDir, patchPath, decision.commitMsg);
        Logger.info("✓ patch applied");

        // Print a brief summary of what just landed (last commit only).
        try {
          const diff = execFileSync(
            "git",
            ["-C", this.projectDir, "diff", "--name-status", "HEAD~1..HEAD"],
            { encoding: "utf8" }
          ).trim();
          if (diff) {
            Logger.info("=== Accepted file changes ===");
            // Lines like: "A\tpath" / "M\tpath" / "D\tpath"
            for (const line of diff.split("\n")) Logger.info(line);
          }
        } catch { /* non-fatal summary */ }
      } catch (e: any) {
        Logger.error("Patch apply failed:", e?.message ?? e);
      }
    }
  }
}
