// src/scheduler/fsm-effects.ts
import { Logger } from "../logger";
import type { AskUserFn } from "./types";

/**
 * Read user text via a single, unified bridge.
 * - If an external `readUserLine` is provided, log the prompt and defer to it.
 * - Otherwise, call the injected `askUser` function (legacy path).
 */
export async function getUserText(args: {
  label: string;
  prompt: string;
  readUserLine?: () => Promise<string | undefined>;
  askUser: AskUserFn;
  log?: (msg: string) => void;
}): Promise<string> {
  const { label, prompt, readUserLine, askUser, log } = args;
  if (typeof readUserLine === "function") {
    if (log) log(`[${label}] ${prompt}`);
    const line = await readUserLine();
    return (line ?? "").trim();
  }
  const text = await askUser(label, prompt);
  return (text ?? "").trim();
}
