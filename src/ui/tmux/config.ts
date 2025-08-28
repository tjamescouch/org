// src/ui/tmux/config.ts
import * as os from "os";
import * as path from "path";

export type TmuxConfigOptions = {
  // Show a mild help in the statusline
  hint?: string;
  // Clipboard helpers discovered by launcher (pbcopy/xclip/wl-copy present?)
  clipboardHelper?: "pbcopy" | "xclip" | "wl-copy" | null;
  // Default mouse on/off
  mouse?: boolean;
};

export function buildEphemeralTmuxConf(opts: TmuxConfigOptions = {}): string {
  const mouse = opts.mouse ?? true;
  const hint = opts.hint ?? "prefix: C-b | p: patch popup | m: toggle mouse";
  const termOverrides = '",*:Tc"'; // truecolor
  const home = os.homedir();
  const sockInfo = path.join(home, ".cache", "org"); // just a note in status-right if you want

  // Clipboard bindings
  let copyBinding = "";
  if (opts.clipboardHelper === "pbcopy") {
    copyBinding =
      'bind y run "tmux save-buffer - | pbcopy" \\; display-message \\"Copied to system clipboard\\"';
  } else if (opts.clipboardHelper === "xclip") {
    copyBinding =
      'bind y run "tmux save-buffer - | xclip -selection clipboard -in" \\; display-message \\"Copied to clipboard (xclip)\\"';
  } else if (opts.clipboardHelper === "wl-copy") {
    copyBinding =
      'bind y run "tmux save-buffer - | wl-copy" \\; display-message \\"Copied to clipboard (wl-copy)\\"';
  } else {
    // Fallback: rely on OSC52 when supported
    copyBinding = 'bind y display-message "Copy: rely on OSC52 (terminal dependent)"';
  }

  return [
    // --- sensible defaults for good visuals/clipboard ---
    "set -g assume-paste-time 0",
    "set -g base-index 1",
    "set -g pane-base-index 1",
    "set -g history-limit 100000",
    `set -ag terminal-overrides ${termOverrides}`,
    "set -g set-clipboard on",
    `set -g mouse ${mouse ? "on" : "off"}`,

    // Toggle mouse quickly if users want terminal-native selection
    'bind m set -g mouse \\; display-message "mouse: #{?mouse,on,off}"',

    // Clipboard helper binding
    copyBinding,

    // Patch popup: the app can provide a command in $ORG_PATCH_POPUP_CMD
    // If not set, just print a message.
    'bind p if -F "#{?env:ORG_PATCH_POPUP_CMD,1,0}" "display-popup -E \\"sh -lc \'$ORG_PATCH_POPUP_CMD\'\\"" "display-message \\"No patch popup command configured\\""',

    // Statusline with a hint
    'set -g status-interval 2',
    `set -g status-right "#[fg=cyan]${hint} #[fg=white]| #[fg=yellow]#{session_name}"`,
  ].join("\n");
}
