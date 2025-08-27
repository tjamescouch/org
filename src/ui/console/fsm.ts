export enum Mode {
  IDLE = "IDLE",           // waiting for ESC / 'i' / first printable
  INTERJECT = "INTERJECT", // user is typing a line; we live-echo
  CONFIRM = "CONFIRM",     // y/N confirm dialog (handled outside the loop)
  EXITING = "EXITING",
}

export interface Fsm {
  mode: Mode;
  // Accumulate raw bytes for interjection
  buf: Buffer[];
}

export function createFsm(): Fsm {
  return { mode: Mode.IDLE, buf: [] };
}

export function isPrintableByte(b: number): boolean {
  // Skip ESC, CR, LF. Backspace is handled separately.
  if (b === 0x1b || b === 0x0a || b === 0x0d) return false;
  // Treat everything else as printable for our purposes.
  return true;
}

export function toUtf8(bufs: Buffer[]): string {
  return Buffer.concat(bufs).toString("utf8");
}
