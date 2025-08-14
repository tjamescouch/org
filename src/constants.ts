export const VERBOSE = false;

// ANSI color helpers.  These functions return escape codes used to
// style terminal output with various colours.  Moving them into
// constants allows reuse across modules (e.g. agent-model.ts and
// transport/chat.ts).
export const Reset = () => "\x1b[0m";
export const CyanTag = () => "\x1b[36m";
export const YellowTag = () => "\x1b[33m";
export const RedTag = () => "\x1b[31m";
export const GreenTag = () => "\x1b[32m";
export const BlueTag = () => "\x1b[34m";
export const MagentaTag = () => "\x1b[35m";
export const WhiteTag = () => "\x1b[37m";
export const BrightBlackTag = () => "\x1b[90m"; // gray
export const BrightRedTag = () => "\x1b[91m";
export const BrightGreenTag = () => "\x1b[92m";
export const BrightYellowTag = () => "\x1b[93m";
export const BrightBlueTag = () => "\x1b[94m";
export const BrightMagentaTag = () => "\x1b[95m";
export const BrightCyanTag = () => "\x1b[96m";
export const BrightWhiteTag = () => "\x1b[97m";