// src/ui/console/index.ts
// Passive console UI: the InputController is now the sole owner of stdin.
// We just return 0 and let app.ts / scheduler control lifetime.

import { Logger } from "../../logger";

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  // No stdin listeners here. This avoids double-echo and weird focus issues.
  Logger.debug("[console-ui] passive mode (InputController owns stdin)");
  return 0;
}
