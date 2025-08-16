// src/ui/colors.ts
// Backward-compatible color API + muted palette.
// Exports:
//   - Colors (palette object)
//   - C (alias for Colors)
//   - colorOn(name), colorOff(), colorize(name, text)
//   - ColorKey (type)

export type ColorKey =
  | "reset" | "dim"
  | "user" | "agent" | "system"
  | "debug" | "info" | "warn" | "error" | "think";

// Muted palette for better readability in most terminals
export const Colors: Record<ColorKey, string> = {
  // resets
  reset: "\x1b[0m",
  dim:   "\x1b[2m",

  // speakers
  user:   "\x1b[38;5;245m", // mid light gray
  agent:  "\x1b[38;5;252m", // soft white (not blown-out)
  system: "\x1b[38;5;244m", // gray

  // logs
  debug: "\x1b[38;5;67m",   // muted steel blue
  info:  "\x1b[38;5;66m",   // teal-ish
  warn:  "\x1b[38;5;178m",  // amber
  error: "\x1b[38;5;167m",  // dark red
  think: "\x1b[38;5;171m",  // darker fuchsia (CoT)
};

// Legacy alias some modules/tests import
export const C = Colors;

/** Return ANSI "on" code for a palette entry. */
export function colorOn(name: ColorKey): string {
  return Colors[name];
}

/** Return ANSI "off" (reset) code. */
export function colorOff(): string {
  return Colors.reset;
}

/** Wrap text with the given color and reset at the end. */
export function colorize(name: ColorKey, text: string): string {
  return `${Colors[name]}${text}${Colors.reset}`;
}

