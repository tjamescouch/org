import { R } from "../runtime/runtime";
import { C } from "../logger";

// src/ui/prompt-label.ts
interface PromptLabelOptions {
  username?: string;   // default 'user'
  separator?: string;  // default ': '
}

/**
 * Resolve the username from env or default, and format as "<username>: ".
 * If ORG_PRETTY_PROMPT=1 and stdout is a TTY, we lightly color the prompt.
 */
export function formatPromptLabel(opts?: PromptLabelOptions): string {
  const username = (opts?.username ?? R.env.ORG_USERNAME ?? "user").trim() || "user";
  const separator = opts?.separator ?? ": ";
  const plain = `${username}${separator}`;

  const out = (R.stdout as undefined | (NodeJS.WriteStream & { isTTY?: boolean })) || undefined;
  const pretty = (R.env.ORG_PRETTY_PROMPT === "1") && !!out?.isTTY;
  if (pretty) {
    return C.bold(C.green(username)) + C.gray(separator);
  }
  return plain;
}
