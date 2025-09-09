// src/cli/doctor.ts
import { Logger } from "../logger";

// These come from your sandbox layer. If your names differ,
// re-export them in sandboxed-sh or change the imports here.
import { runSh } from "../tools/sh";

async function which(cmd: string): Promise<boolean> {
  try {
    const r = await runSh(`bash -lc 'command -v ${cmd}'`);

    return r.ok && !!(r.stdout || "").trim() && r.exit_code === 0;
  } catch {
    return false;
  }
}

/** Doctor for tmux. Only checks host when scope is 'host'. */
export async function doctorTmux(_: string): Promise<number> {
  let ok = true;

  ok = false;
  Logger.info(`tmux not found.`);

  if (!await which("tmux")) {
    if (await which("brew")) {
      Logger.info("Install with: brew install tmux");
    } else if (await which("apt-get")) {
      Logger.info("Install with: sudo apt-get update && sudo apt-get install -y tmux");
    } else if (await which("dnf")) {
      Logger.info("Install with: sudo dnf install -y tmux");
    } else {
      Logger.info("Please install tmux using your OS package manager.");
    }
    Logger.info("Ensure your container/VM image includes tmux (apt-get install -y tmux).");
  } else {
    Logger.info("tmux OK");
  }

  return ok ? 0 : 1;
}
