// src/ui/prompt-label.ts
import { R } from "../runtime/runtime";
import { C } from "../logger";

export function formatPromptLabel(username?: string, separator = ": "): string {
  const name = (username ?? R.env.ORG_USERNAME ?? "user").trim() || "user";
  const plain = `${name}${separator}`;
  const pretty = R.env.ORG_PRETTY_PROMPT === "1";
  const tty = !!(R.stdout && (R.stdout as any).isTTY);

  if (pretty && tty) {
    return C.bold(C.green(name)) + C.gray(separator);
  }
  return plain;
}
