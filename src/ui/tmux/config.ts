// src/ui/tmux/config.ts
// Ephemeral tmux.conf generator used by the launcher.
// IMPORTANT: only server/global options here — NO target-dependent commands
// so that the file is safe to parse BEFORE any session exists (tmux 3.3a).

export type EphemeralConfOpts = {
  /** purely cosmetic hint you show elsewhere */
  hint?: string;
  /** pbcopy/xclip/wl-copy; we don’t need it inside this conf */
  clipboardHelper?: "pbcopy" | "xclip" | "wl-copy" | null;
  /** enable mouse if desired (default true) */
  mouse?: boolean;
};

export function buildEphemeralTmuxConf(opts: EphemeralConfOpts = {}): string {
  const mouse = opts.mouse ?? true;

  const lines: string[] = [
    // ---- terminal behavior (3.3a-compatible) ----
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"',

    // input/refresh behavior
    "set -s escape-time 0",
    "set -g status-interval 2",
    "set -g focus-events on",

    // vi-ish key behavior in copy-mode and command line
    "set -g status-keys vi",
    "set -g mode-keys vi",

    // toggle mouse support globally (safe pre-session)
    mouse ? "set -g mouse on" : "set -g mouse off",

    // do not kill the server if last session dies while we debug
    "set -s exit-empty off",

    // session/window defaults that don’t need a target
    "set -g base-index 1",
    "setw -g pane-base-index 1",

    // keep pane visible after the inner program exits (so users can read errors)
    "set -g remain-on-exit on",
    "set -g detach-on-destroy off",

    // quiet reduces noisy messages; our code logs explicitly when needed
    "set -s quiet on",
  ];

  // NOTE: DO NOT add rename-window/select-window/display-message here since
  // they need a current target and conf is parsed before a session exists.
  return lines.join("\n") + "\n";
}
