/* tmux config generator — keep it small & portable */

export interface TmuxConfOpts {
  /** Set default terminal advertised by tmux to panes */
  defaultTerminal?: "tmux-256color" | "screen-256color" | "xterm-256color";
  /** Add TrueColor overrides for common terms */
  addTrueColorOverrides?: boolean;
  /** Quiet tmux’s own logging (we still request -vv when launching) */
  quiet?: boolean;
}

/** Render a minimal, safe tmux.conf for our interactive pane. */
export function renderTmuxConf(opts: TmuxConfOpts = {}): string {
  const {
    defaultTerminal = "tmux-256color",
    addTrueColorOverrides = true,
    quiet = true,
  } = opts;

  const lines: string[] = [];

  // Don’t drop the server when last session exits (we manage lifecycle)
  lines.push(`set -s exit-empty off`);

  // Terminal / colors
  lines.push(`set -g default-terminal "${defaultTerminal}"`);
  if (addTrueColorOverrides) {
    // Make TrueColor work in common terminals
    lines.push(`set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"`);
  }

  // UX: allow focus events (apps can use it), but otherwise keep tmux quiet.
  lines.push(`set -g focus-events on`);
  if (quiet) lines.push(`set -s quiet on`);

  // We don’t install any key bindings here; the app owns the UI.
  lines.push("");

  return lines.join("\n");
}
