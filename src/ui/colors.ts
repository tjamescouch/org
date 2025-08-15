export const C = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",

  // muted/darker
  debug: "\x1b[38;5;244m",   // mid grey
  info:  "\x1b[38;5;245m",   // light grey
  warn:  "\x1b[38;5;178m",   // amber
  error: "\x1b[38;5;160m",   // red

  // roles
  user:       "\x1b[38;5;252m",
  assistant:  "\x1b[38;5;250m",

  // chain-of-thought (darker fuchsia)
  think: "\x1b[38;5;125m"
} as const;

export function colorOn(): boolean {
  return process.env.NO_COLOR !== "1";
}
