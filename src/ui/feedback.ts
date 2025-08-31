// src/ui/feedback.ts
import { stderr } from "node:process";

export type FeedbackHandle = { done: () => void };

export interface FeedbackController {
  begin: (message: string) => FeedbackHandle;
  pauseLogs: () => void;
  resumeLogs: () => void;
  isPaused: () => boolean;
}

export function createFeedbackController(opts?: {
  spinner?: boolean;
  intervalMs?: number;
  write?: (s: string) => void;
  pause?: () => void;
  resume?: () => void;
}): FeedbackController {
  let paused = false;
  let timer: NodeJS.Timeout | null = null;
  const glyphs = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let idx = 0;

  const write = opts?.write ?? ((s: string) => { try { stderr.write(s); } catch {} });
  const pauseFn = opts?.pause ?? (() => { paused = true; });
  const resumeFn = opts?.resume ?? (() => { paused = false; });

  function stopSpinner() {
    if (timer) { clearInterval(timer); timer = null; write("\r"); }
  }

  return {
    pauseLogs: () => pauseFn(),
    resumeLogs: () => resumeFn(),
    isPaused: () => paused,
    begin: (message: string) => {
      // pause logs immediately, print newline + message
      pauseFn();
      write(`\n${message}\n`);
      if (opts?.spinner !== false) {
        const ms = opts?.intervalMs ?? 120;
        timer = setInterval(() => {
          write(`\r${glyphs[idx++ % glyphs.length]} `);
        }, ms);
      }
      return {
        done: () => {
          stopSpinner();
          resumeFn();
        },
      };
    },
  };
}
