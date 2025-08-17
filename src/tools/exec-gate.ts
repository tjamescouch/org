/**
 * ExecutionGate & ExecutionGuards
 * -------------------------------
 * - If `safe` is true, the gate prompts the user before executing a command.
 * - Guards are an extensible chain to allow/deny commands (policy hook).
 * - No monkey patching or global hacks; pure functional API plus small static.
 */

export abstract class ExecutionGuard {
  /** Return false to veto execution. Can be async. */
  abstract allow(cmd: string): Promise<boolean> | boolean;
}

export class AllowAllGuard extends ExecutionGuard {
  async allow(_cmd: string) { return true; }
}

export interface GateOptions {
  safe: boolean;
  guards?: ExecutionGuard[];
  promptFn?: (text: string) => Promise<boolean>; // for testing / custom UIs
}

export class ExecutionGate {
  private static _safe = false;
  private static _guards: ExecutionGuard[] = [new AllowAllGuard()];
  private static _prompt: GateOptions["promptFn"] | undefined;

  static configure(opts: GateOptions) {
    this._safe = !!opts.safe;
    this._guards = (opts.guards && opts.guards.length > 0) ? opts.guards : [new AllowAllGuard()];
    this._prompt = opts.promptFn;
  }

  static isSafe(): boolean { return this._safe; }

  static async check(cmd: string): Promise<boolean> {
    for (const g of this._guards) {
      const ok = await g.allow(cmd);
      if (!ok) return false;
    }
    if (!this._safe) return true;

    // Ask user for confirmation when safe mode is enabled.
    if (this._prompt) return await this._prompt(`Run: ${cmd}? [y/N] `);

    const rl = await import("readline");
    return await new Promise<boolean>((resolve) => {
      const rli = rl.createInterface({ input: process.stdin, output: process.stdout });
      rli.question(`Run: ${cmd}? [y/N] `, (ans) => {
        rli.close();
        const v = String(ans || "").trim().toLowerCase();
        resolve(v === "y" || v === "yes");
      });
    });
  }
}
