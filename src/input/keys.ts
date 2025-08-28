// src/input/keys.ts
// Minimal, dependable key decoder for raw-mode stdin.

export type KeyEvent =
  | { type: "esc" }
  | { type: "enter" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "backspace" }
  | { type: "tab" }
  | { type: "left" | "right" | "up" | "down" }
  | { type: "char"; data: string }
  | { type: "unknown"; raw: Buffer };

const isPrintable = (s: string) =>
  // crude but effective; we accept all non-control once decoded as UTF-8.
  !!s && !/[\u0000-\u001f]/.test(s);

export function decodeKey(chunk: Buffer): KeyEvent {
  if (!chunk || chunk.length === 0) return { type: "unknown", raw: chunk };

  // Single-byte control keys
  if (chunk.length === 1) {
    const c = chunk[0];
    switch (c) {
      case 0x03: return { type: "ctrl-c" };    // ^C
      case 0x04: return { type: "ctrl-d" };    // ^D
      case 0x09: return { type: "tab" };
      case 0x0d:
      case 0x0a: return { type: "enter" };
      case 0x1b: return { type: "esc" };
      case 0x7f: return { type: "backspace" };
      default: {
        const s = Buffer.from([c]).toString("utf8");
        return isPrintable(s) ? { type: "char", data: s } : { type: "unknown", raw: chunk };
      }
    }
  }

  // CSI sequences (arrows, etc): ESC [ A/B/C/D
  if (chunk[0] === 0x1b && chunk[1] === 0x5b) {
    const code = chunk[2];
    switch (code) {
      case 0x41: return { type: "up" };
      case 0x42: return { type: "down" };
      case 0x43: return { type: "right" };
      case 0x44: return { type: "left" };
      default:   return { type: "unknown", raw: chunk };
    }
  }

  // Fallback: treat as UTF-8 printable
  const s = chunk.toString("utf8");
  if (isPrintable(s)) return { type: "char", data: s };
  return { type: "unknown", raw: chunk };
}
