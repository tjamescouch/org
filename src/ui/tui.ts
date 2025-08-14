/* -------------------- tiny TUI helpers -------------------- */
export const esc = (s: string) => `\u001b[${s}`;
export const CSI = {
  clear: esc("2J"),
  home: esc("H"),
  hide: esc("?25l"),
  show: esc("?25h"),
  rev:  esc("7m"),
  nrm:  esc("0m"),
};