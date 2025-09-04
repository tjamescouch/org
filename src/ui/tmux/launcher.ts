// src/ui/tmux/launcher.ts
// Historical entry-point kept for compatibility. Delegate to index.ts.

import { launchTmuxUI } from "./index";

export async function launch(_argv: string[], _scope: "container" | "host" = "container"): Promise<number> {
  return launchTmuxUI(_argv);
}
