export const Colors = {
  // resets
  reset: "\x1b[0m",
  dim:   "\x1b[2m",

  // speakers
  user:   "\x1b[38;5;245m", // mid gray
  agent:  "\x1b[38;5;252m", // soft white (not blown out)
  system: "\x1b[38;5;244m", // gray

  // logs
  debug: "\x1b[38;5;67m",   // muted steel blue
  info:  "\x1b[38;5;66m",   // teal-ish
  warn:  "\x1b[38;5;178m",  // amber
  error: "\x1b[38;5;167m",  // dark red
  think: "\x1b[38;5;171m",  // darker fuchsia for CoT
};
