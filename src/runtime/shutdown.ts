import { Logger } from "../logger";
import type { RoundRobinScheduler } from "../scheduler";

export function installShutdown(scheduler: RandomScheduler) {
  const handle = async (exitCode: number) => {
    try {
      // stop tool loops, wait for any active agent to finish
      await scheduler.drain?.();
      // one last finalize + review/apply across all agent sessions
      await scheduler.finalizeAndReviewAll?.();
    } catch (e: any) {
      Logger.error("shutdown:", e?.message ?? e);
    } finally {
      process.stdout.write("\n");
      process.exit(exitCode);
    }
  };

  process.on("SIGINT",  () => void handle(130)); // Ctrl+C
  process.on("SIGTERM", () => void handle(143)); // kill/terminate
}


/**
 * Graceful shutdown used by the UI (e.g., ESC key).
 * - Stops the scheduler (no new work).
 * - Attempts to finalize any active sandbox sessions (if the sandbox runtime is present).
 * - Exits the process when done.
 *
 * NOTE: This is best-effort; if the sandbox module is not present, we just exit.
 */
export async function gracefulExit(
  opts: { scheduler?: RoundRobinScheduler; exitCode?: number } = {}
): Promise<never> {
  try {
    Logger.info("Graceful shutdown requested… saving session artifacts. Press Ctrl+C to abort.");

    // Stop new work quickly
    try {
      await review.finalizeAndReview(agents.map(a => a.id));
      opts.scheduler?.stop();
    } catch {
      /* ignore */
    }

    // Try to finalize sandbox sessions if the optional module exists
    try {
      // Optional dependency — only present in sandbox-enabled builds
      const mod: any = await import("../tools/sandboxed-sh").catch(() => null);
      if (mod) {
        if (typeof mod.finalizeAllSandboxes === "function") {
          await mod.finalizeAllSandboxes();
        } else if (typeof mod.finalizeSandbox === "function") {
          // Some trees only export a per-session finalizer
          await mod.finalizeSandbox({} as any);
        }
      }
    } catch (e) {
      Logger.warn?.("Sandbox finalize skipped:", (e as Error)?.message ?? e);
    }
  } finally {
    // Always exit — even if finalize throws. ESC is an explicit quit.
    process.stdout.write("\n");
    process.exit(opts.exitCode ?? 0);
    // Help TypeScript understand we never return.
    // @ts-expect-error
    return Promise.reject();
  }
}
