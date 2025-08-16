/**
 * Safe-mode confirmation utility.
 *
 * Usage:
 *   if (await confirm("About to run: sh -c 'rm -rf …'")) { ... run ... }
 *
 * Confirmation triggers when either SAFE_MODE=1 or process.argv contains --safe.
 * When not in safe mode, confirm() resolves to true immediately (no prompt).
 */
import type { ReadStream, WriteStream } from "node:tty";

export function shouldUseSafeMode(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.SAFE_MODE === "1" || argv.includes("--safe");
}

/**
 * Simple interactive y/N prompt. When not TTY (e.g., piped), defaults to false in safe-mode.
 */
export async function confirm(
  question: string,
  opts?: {
    defaultYes?: boolean;
    input?: NodeJS.ReadStream & Partial<ReadStream>;
    output?: NodeJS.WriteStream & Partial<WriteStream>;
  }
): Promise<boolean> {
  // If not in safe-mode, allow automatically.
  if (!shouldUseSafeMode()) return true;

  const input = opts?.input ?? (process.stdin as any);
  const output = opts?.output ?? (process.stdout as any);
  const defaultYes = !!opts?.defaultYes;

  // If we can't interact, be conservative: don't allow.
  if (!input || !("isTTY" in input) || !input.isTTY) {
    return false;
  }

  // Small helper to read a single keystroke.
  const promptOnce = (): Promise<string> =>
    new Promise((resolve) => {
      try { input.setRawMode?.(true); } catch (e) { console.error(e) }
      const onData = (buf: Buffer) => {
        try { input.setRawMode?.(false); } catch (e) { console.error(e) }
        input.removeListener("data", onData);
        resolve(String(buf || "").trim());
      };
      input.on("data", onData);
    });

  output.write(`[SAFE] ${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  const key = (await promptOnce()).toLowerCase();
  output.write("\n");

  if (!key) return defaultYes;
  return key === "y" || key === "yes";
}
