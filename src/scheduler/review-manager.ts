// src/scheduler/review-manager.ts
import * as fs from "fs";
import { Logger } from "../logger";
import { finalizeSandbox } from "../tools/sandboxed-sh";
import { modeFromEnvOrFlags, decideReview, applyPatch } from "../review";

/**
 * Handles post-tool-call patch finalization and review/apply workflow.
 * Single responsibility: interpret sandbox artifacts and, if present,
 * go through the selected review mode.
 */
export class ReviewManager {
  constructor(private projectDir: string, private reviewMode: string) {}

  async afterToolBatch(agentSessionId: string): Promise<void> {
    const ctx = { projectDir: this.projectDir, agentSessionId };
    const fin = await finalizeSandbox(ctx as any);
    const patchPath = (fin as any)?.patchPath as string | undefined;

    if (patchPath && fs.existsSync(patchPath)) {
      const mode = modeFromEnvOrFlags(this.reviewMode); // e.g. ask|auto|never
      const decision = await decideReview(mode, this.projectDir, patchPath);
      if (decision.action === "apply") {
        try {
          await applyPatch(this.projectDir, patchPath, decision.commitMsg);
          Logger.info("✓ patch applied");
        } catch (e: any) {
          Logger.error("Patch apply failed:", e?.message ?? e);
        }
      }
    }
  }
}
