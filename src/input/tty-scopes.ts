// src/input/tty-scopes.ts
// Thin alias so older imports using "*tty-scopes*" keep working.

import {
  TtyController as _TtyController,
  stdinTty,
  withCookedTTY as withCooked,
  withRawTTY as withRaw,
  type TtyIn,
  type TtyMode,
} from "./tty-controller";

export type { TtyIn, TtyMode } from "./tty-controller";

/** Back-compat class name that simply extends the main controller. */
export class TtyScopes extends _TtyController {}

/** Convenience singleton bound to process.stdin. */
export const defaultTtyScopes = new TtyScopes({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
});

export const withCookedTTY = withCooked;
export const withRawTTY = withRaw;
