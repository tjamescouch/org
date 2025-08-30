/**
 * Single ExecutionGate for the whole app.
 * - Only prompts when SAFE mode is enabled.
 * - If SAFE + nonInteractive → throws at configure().
 * - Extensible guard chain allows policy checks (denylist, cwd, etc.)
 */

import { promptLine } from "../utils/prompt-line";
import { ExecutionGuard, NoDangerousRm, NoGitAdd, NoGitCommit, NoGitPush, NoRm } from "./execution-guards";
import { withCookedTTY } from "../input/tty-controller";


type GateConfig = { safe: boolean; interactive: boolean; guards?: ExecutionGuard[] };

export class ExecutionGate {
  private static _safe = false;
  private static _interactive = true;
  private static _guards: ExecutionGuard[] = [new NoDangerousRm(), new NoRm(), new NoGitPush(), new NoGitCommit(), new NoGitAdd()];

  static configure(cfg: GateConfig) {
    this._safe = Boolean(cfg.safe);
    this._interactive = Boolean(cfg.interactive);
    this._guards = Array.isArray(cfg.guards) ? cfg.guards : [];
    if (this._safe && !this._interactive) {
      throw new Error("SAFE mode requires interactive mode (safe + non-interactive is not allowed).");
    }
  }

  /** Ask user only when SAFE is true. Otherwise, pass-through. */
  static async gate(hint: string): Promise<void> {
    // Guard chain first (applies for both safe/non-safe)
    for (const g of this._guards) {
      const ok = await Promise.resolve(g.allow(hint));
      if (!ok) throw new Error(`Execution blocked by guard for: ${hint}`);
    }

    if (!this._safe) return;

    // SAFE requires interactive (validated in configure); prompt the user
    await withCookedTTY(async ()=>{
      const question = `Run: ${hint}? [y/N] `;
      const answer = await promptLine(question);
      const yes = typeof answer === "string" && /^y(es)?$/i.test(answer.trim());
      if (!yes) throw new Error(`User denied: ${hint}`);
    });
  }

  static async allow(hint: string): Promise<boolean> {
    try {
      this.gate(hint);
      return true;
    } catch {
      return false;
    }
  }
}

