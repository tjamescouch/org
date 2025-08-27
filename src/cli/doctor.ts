// src/cli/doctor.ts
import { spawnSync } from "child_process";
import { Logger } from "../logger";

/** Run `command -v <cmd>`; returns true if found in PATH. */
function which(cmd: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** Return true if `tmux -V` runs successfully (most reliable presence check). */
export function hasTmuxInstalled(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return r.status === 0;
}

/** Best-effort: get `tmux -V` text for logging (non-fatal if it fails). */
function tmuxVersionString(): string | null {
  const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (r.status === 0) return (r.stdout || r.stderr || "").trim() || "tmux (version unknown)";
  return null;
}

export async function doctorTmux(): Promise<number> {
  let ok = true;

  // --- tmux presence --------------------------------------------------------
  if (!hasTmuxInstalled()) {
    ok = false;
    Logger.info("tmux not found in this environment.");
    if (which("brew")) {
      Logger.info("Install with:  brew install tmux");
    } else if (which("apt-get")) {
      Logger.info("Install with:  sudo apt-get update && sudo apt-get install -y tmux");
    } else if (which("dnf")) {
      Logger.info("Install with:  sudo dnf install -y tmux");
    } else if (which("apk")) {
      Logger.info("Install with:  apk add tmux");
    } else if (which("pacman")) {
      Logger.info("Install with:  sudo pacman -S tmux");
    } else {
      Logger.info("Please install tmux using your OS package manager.");
    }
  } else {
    const ver = tmuxVersionString();
    Logger.info(`tmux OK${ver ? ` — ${ver}` : ""}`);
    // Note: not being *inside* tmux is fine; the app can launch it (e.g. --ui tmux).
    if (!process.env.TMUX) {
      Logger.info("Not currently inside a tmux session (that's OK; the app can start one when needed).");
    }
  }

  // --- Clipboard helper (optional but nice) ---------------------------------
  if (!which("pbcopy") && !which("xclip") && !which("wl-copy")) {
    Logger.info("No clipboard helper found (pbcopy/xclip/wl-copy).");
    Logger.info("OSC52 likely still works, but for robust copy/paste you can install one:");
    if (which("brew")) Logger.info("  brew install xclip            # macOS via XQuartz, or Linux");
    if (which("apt-get")) Logger.info("  sudo apt-get install -y xclip # X11; or 'sudo apt-get install -y wl-clipboard' for Wayland");
    if (which("dnf")) Logger.info("  sudo dnf install -y xclip     # or: sudo dnf install -y wl-clipboard");
  } else {
    Logger.info("Clipboard helper present.");
  }

  return ok ? 0 : 1;
}
