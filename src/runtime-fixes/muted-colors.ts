import { C } from "../ui/colors";
// Darker, more muted palette
const X: any = C as any;
X.reset = "\x1b[0m";
X.debug = "\x1b[38;5;245m";      // dim gray
X.info  = "\x1b[38;5;244m";      // a bit darker
X.warn  = "\x1b[38;5;214m";      // amber (muted)
X.error = "\x1b[38;5;203m";      // muted red
X.think = "\x1b[38;5;171m";      // fuchsia but not neon
X.persona   = "\x1b[38;5;110m";  // slate/teal
X.user      = "\x1b[38;5;117m";  // softened cyan
X.assistant = "\x1b[38;5;153m";  // muted violet
