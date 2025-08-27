// src/cli/doctor.ts
import { spawnSync } from "child_process";
import { Logger } from "../logger";

function which(cmd: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

export async function doctorTmux(): Promise<number> {
  let ok = true;

  if (!which("tmux")) {
    ok = false;
    Logger.info("tmux not found.");
    if (which("brew")) {
      Logger.info("Install with: brew install tmux");
    } else if (which("apt-get")) {
      Logger.info("Install with: sudo apt-get update && sudo apt-get install -y tmux");
    } else if (which("dnf")) {
      Logger.info("Install with: sudo dnf install -y tmux");
    } else {
      Logger.info("Please install tmux using your OS package manager.");
    }
  } else {
    Logger.info("tmux OK");
  }

  if (!which("pbcopy") && !which("xclip") && !which("wl-copy")) {
    Logger.info("No clipboard helper found (pbcopy/xclip/wl-copy).");
    Logger.info("OSC52 likely still works, but for robust copy use:");
    if (which("brew")) Logger.info("  brew install xclip   # mac via XQuartz or Linux: xclip/wl-clipboard");
    if (which("apt-get")) Logger.info("  sudo apt-get install -y xclip  # for X11");
  } else {
    Logger.info("Clipboard helper present.");
  }

  return ok ? 0 : 1;
}
