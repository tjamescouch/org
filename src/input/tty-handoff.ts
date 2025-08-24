// src/input/tty-handoff.ts
import type { ReadStream } from "node:tty";

type SavedListener = [event: string, fn: (...args: any[]) => void];

export type TtyHandoffState = {
  wasTTY: boolean;
  wasRaw: boolean;
  wasPaused: boolean;
  savedListeners: SavedListener[];
};

function stdinStream(): ReadStream {
  return process.stdin as unknown as ReadStream;
}

/**
 * Detach the parent from the TTY so a child (vim, shell, etc.) can own it.
 * - turn off raw mode
 * - pause stdin
 * - remove 'data'/'keypress'/'readable' listeners
 * Returns a token used to restore everything afterwards.
 */
export function beginTtyHandoff(): TtyHandoffState {
  const stdin = stdinStream();

  const state: TtyHandoffState = {
    wasTTY: !!stdin.isTTY,
    wasRaw: false,
    wasPaused: stdin.isPaused(),
    savedListeners: [],
  };

  if (stdin.isTTY) {
    // Remember raw mode and disable it so the child gets canonical input
    // (important for escape sequences / special keys).
    // @ts-ignore - node typings allow this at runtime
    state.wasRaw = !!stdin.isRaw;
    try { stdin.setRawMode(false); } catch {}
  }

  // Capture and remove listeners that could steal keystrokes
  for (const ev of ["data", "keypress", "readable"]) {
    // @ts-ignore - runtime API
    const ls = stdin.listeners(ev) as Array<(...args: any[]) => void>;
    for (const fn of ls) {
      state.savedListeners.push([ev, fn]);
      // @ts-ignore - runtime API
      stdin.removeListener(ev, fn);
    }
  }

  try { stdin.pause(); } catch {}

  return state;
}

/**
 * Restore stdin and listeners after the child exits.
 */
export function endTtyHandoff(state: TtyHandoffState): void {
  const stdin = stdinStream();

  // Re-attach listeners
  for (const [ev, fn] of state.savedListeners) {
    // @ts-ignore - runtime API
    stdin.on(ev, fn);
  }

  // Restore raw mode if it was previously enabled
  if (state.wasTTY && stdin.setRawMode) {
    try { stdin.setRawMode(state.wasRaw); } catch {}
  }

  // Resume if it was not paused before
  if (!state.wasPaused) {
    try { stdin.resume(); } catch {}
  }
}
