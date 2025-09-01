import { R } from "../runtime/runtime";

// src/ui/prompt-label.ts
interface PromptLabelOptions {
  username?: string;   // default 'user'
  separator?: string;  // default ': '
}

/** Resolve the username from env or default, and format as "<username>: ". */
export function formatPromptLabel(opts?: PromptLabelOptions): string {
  const username = (opts?.username ?? R.env.ORG_USERNAME ?? "user").trim() || "user";
  const separator = opts?.separator ?? ": ";
  return `${username}${separator}`;
}
