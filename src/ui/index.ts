import { launchTmuxUI } from "./tmux/index";
import { launchConsoleUI } from "./console/index";

export async function launchUI(kind: string | undefined, argv: string[]): Promise<number> {
  const k = (kind ?? "console").toLowerCase();
  if (process.env.ORG_UI_TRACE === "1") {
    process.stderr.write(`[ui] selected=${k}\n`);
  }
  return k === "tmux" ? launchTmuxUI(argv) : launchConsoleUI(argv);
}
