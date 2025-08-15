import { Logger } from "../logger";
export async function installDebugHooks(): Promise<void> {
  // Keep this intentionally minimal and non-invasive.
  Logger.info("debug-hooks: installed (no-op)");
}
