// src/input/tty-adapter.ts
import type { TtyIn } from "./tty-controller";
import type { ReadStream as TtyReadStream } from "node:tty";

/** Narrow to a TTY read stream if it exposes setRawMode. */
function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return "setRawMode" in (s as object)
      && typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}

/** Detect presence of the isRaw flag (exposed after toggling raw in Node). */
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return "isRaw" in (s as object)
      && typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

/** Convert any NodeJS.ReadStream into a minimal TtyIn (type‑safe, no `as any`). */
export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = { isTTY: stream.isTTY === true };

  if (hasIsRaw(stream)) {
    base.isRaw = stream.isRaw;
  }
  if (hasSetRawMode(stream)) {
    base.setRawMode = (mode: boolean) => (stream as TtyReadStream).setRawMode(mode);
  }
  return base;
}

/** Convenience: adapt process.stdin. */
export function stdinTty(): TtyIn {
  return toTtyIn(process.stdin);
}
