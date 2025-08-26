import * as fs from "fs";
import { Logger } from "../logger";
import { finalizeSandbox } from "../tools/sandboxed-sh";
import { modeFromEnvOrFlags, decideReview } from "../review";
import { applySessionPatch } from "../cli/apply-patch";

export class ReviewManager {
  private dirty = new Set<string>();

  constructor(private projectDir: string, private reviewMode: string) {}

  /** Mark an agent session as having changes; no finalization yet. */
  markDirty(agentSessionId: string) {
    this.dirty.add(agentSessionId);
  }

async finalizeAndReview(agentSessionIds?: string[]): Promise<void> {
  const ids = (agentSessionIds && agentSessionIds.length > 0)
    ? agentSessionIds
    : Array.from(this.dirty);

  this.dirty.clear(); // idempotent

  // Determine effective review mode with a non-TTY fallback
  const isInteractive = !!process.stdout.isTTY && !!process.stdin.isTTY;
  let mode = modeFromEnvOrFlags(this.reviewMode);           // "ask" | "auto" | "never"
  if (mode === "ask" && !isInteractive) mode = "auto";      // degrade when we can’t prompt

  for (const agentSessionId of ids) {
    const fin = await finalizeSandbox({ projectDir: this.projectDir, agentSessionId } as any);
    const patchPath = (fin as any)?.patchPath as string | undefined;

    if (!patchPath || !fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) {
      continue; // nothing to review/apply
    }

    const decision = await decideReview(mode, this.projectDir, patchPath /* , { isTty: isInteractive } if your decideReview supports it */);

    if (decision.action === "apply") {
      try {
        await applySessionPatch(this.projectDir, patchPath, decision.commitMsg);
        Logger.info("✓ patch applied");
      } catch (e: any) {
        Logger.error("Patch apply failed:", e?.message ?? e);
      }
    }
  }
}
}
