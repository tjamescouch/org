// src/input/fsm.ts
// Small explicit FSM that owns the prompt & user typing lifecycle.

import type { KeyEvent } from "./keys";

export type State = "idle" | "interject";
export interface FsmIO {
  write(s: string): void;           // usually stdout.write
  bell?(): void;                    // optional: '\x07'
}

export interface FsmHooks {
  onSubmit(text: string): void;     // when user presses Enter in interject
  onCancel(): void;                 // when user presses Esc in interject
  onEscapeIdle(): void;             // when user presses Esc in idle
  banner?: string;                  // e.g., "You: "
  interjectKey?: string;            // default "i"
}

export class InputFSM {
  private io: FsmIO;
  private hooks: FsmHooks;
  private state: State = "idle";
  private buf: string[] = [];

  constructor(io: FsmIO, hooks: FsmHooks) {
    this.io = io;
    this.hooks = { banner: "You: ", interjectKey: "i", ...hooks };
  }

  /** External entrypoint for key events */
  handle(e: KeyEvent) {
    if (this.state === "idle") return this.handleIdle(e);
    return this.handleInterject(e);
  }

  /** Begin interject, optionally seeded with a first char (already typed). */
  beginInterject(seed?: string) {
    if (this.state !== "idle") return;
    this.state = "interject";
    this.buf = [];
    this.io.write(this.hooks.banner!);
    if (seed) {
      this.buf.push(seed);
      this.io.write(seed);
    }
  }

  private handleIdle(e: KeyEvent) {
    switch (e.type) {
      case "esc":
        this.hooks.onEscapeIdle();
        return;
      case "char": {
        // If user pressed configured interject key, open empty prompt.
        if (e.data === this.hooks.interjectKey) {
          this.beginInterject();
        } else {
          // Any printable char auto-enters interject seeded with that char.
          this.beginInterject(e.data);
        }
        return;
      }
      case "enter":
      case "tab":
      case "backspace":
      case "left":
      case "right":
      case "up":
      case "down":
        // ignore in idle
        return;
      case "ctrl-c":
      case "ctrl-d":
        this.hooks.onEscapeIdle();
        return;
      default:
        return;
    }
  }

  private handleInterject(e: KeyEvent) {
    switch (e.type) {
      case "esc":
        this.io.write("\n");
        this.buf = [];
        this.state = "idle";
        this.hooks.onCancel();
        return;

      case "enter": {
        const text = this.buf.join("");
        this.io.write("\n");
        this.buf = [];
        this.state = "idle";
        this.hooks.onSubmit(text);
        return;
      }

      case "backspace": {
        if (this.buf.length > 0) {
          this.buf.pop();
          // Erase last char visually: backspace, space, backspace.
          this.io.write("\b \b");
        } else {
          this.io.bell?.();
        }
        return;
      }

      case "char":
        this.buf.push(e.data);
        this.io.write(e.data);
        return;

      // Mildly ignore navigation keys in this minimal prompt
      case "tab":
      case "left":
      case "right":
      case "up":
      case "down":
      default:
        return;
    }
  }
}
