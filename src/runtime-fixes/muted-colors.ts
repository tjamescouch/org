import { C } from "../ui/colors";
const X: any = C as any;
X.reset = "\x1b[0m";
X.debug = "\x1b[38;5;245m";      // dim gray
X.info  = "\x1b[38;5;244m";
X.warn  = "\x1b[38;5;214m";      // muted amber
X.error = "\x1b[38;5;203m";      // muted red
X.persona   = "\x1b[38;5;110m";  // slate/teal
X.user      = "\x1b[38;5;117m";  // softened cyan
X.assistant = "\x1b[38;5;153m";  // muted violet
X.think     = "\x1b[38;5;171m";  // softer fuchsia
