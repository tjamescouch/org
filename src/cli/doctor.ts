// src/cli/doctor.ts
import { spawnSync } from "node:child_process";
import { Logger } from "../logger";

// These come from your sandbox layer. If your names differ,
// re-export them in sandboxed-sh or change the imports here.
import { shCapture } from "../tools/sandboxed-sh";

export type TmuxScope = "host" | "container";

/** Host-side `command -v` */
function whichHost(cmd: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** Sandbox-side `command -v` (no TTY) */
async function whichSandbox(cmd: string): Promise<boolean> {
  try {
    const r = await shCapture(`bash -lc 'command -v ${cmd}'`);
    return r.code === 0 && !!(r.out || "").trim();
  } catch {
    return false;
  }
}

/** Probe for tmux in the requested scope */
export async function hasTmuxInstalled(scope: TmuxScope = "host"): Promise<boolean> {
  if (scope === "host") return whichHost("tmux");
  return await whichSandbox("tmux");
}

/** Doctor for tmux. Only checks host when scope is 'host'. */
export async function doctorTmux(scope: TmuxScope = "host"): Promise<number> {
  let ok = true;

  if (!(await hasTmuxInstalled(scope))) {
    ok = false;
    const where = scope === "host" ? "host" : "container";
    Logger.info(`tmux not found in ${where}.`);

    if (scope === "host") {
      if (whichHost("brew")) {
        Logger.info("Install with: brew install tmux");
      } else if (whichHost("apt-get")) {
        Logger.info("Install with: sudo apt-get update && sudo apt-get install -y tmux");
      } else if (whichHost("dnf")) {
        Logger.info("Install with: sudo dnf install -y tmux");
      } else {
        Logger.info("Please install tmux using your OS package manager.");
      }
    } else {
      Logger.info("Ensure your container/VM image includes tmux (apt-get install -y tmux).");
    }
  } else {
    Logger.info("tmux OK");
  }

  // Clipboard helpers are only meaningful on host.
  if (scope === "host") {
    if (!whichHost("pbcopy") && !whichHost("xclip") && !whichHost("wl-copy")) {
      Logger.info("No clipboard helper found (pbcopy/xclip/wl-copy).");
      Logger.info("OSC52 likely still works, but for robust copy use:");
      if (whichHost("brew")) Logger.info("  brew install xclip   # mac via XQuartz or Linux: xclip/wl-clipboard");
      if (whichHost("apt-get")) Logger.info("  sudo apt-get install -y xclip  # for X11");
    } else {
      Logger.info("Clipboard helper present.");
    }
  }

  return ok ? 0 : 1;
}
