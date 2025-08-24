// src/sanitizer.ts
import { ChatToolCall } from "../drivers/types";
import { GuardDecision } from "../guardrails/guardrail";

export function sanitizeAndRepairAssistantReply(args: {
  text?: string;
  calls?: ChatToolCall[] | null;
  toolsAllowed?: readonly string[];
  didRetry?: boolean;
}): {
  text: string;
  calls: ChatToolCall[];
  decision?: GuardDecision;
  forceRetry?: boolean;
} {
  const text0 = stripAlienWrappers(args.text ?? "");
  const allowed = normalizeAllowed(args.toolsAllowed);

  // 1) If we already have valid calls, keep them; drop chat text unless it's a file/tag block.
  const vetted = validateCalls(args.calls, allowed);
  if (vetted.ok) {
    const keepText = containsFileTag(text0);
    return { text: keepText ? text0 : "", calls: vetted.calls };
  }

  // 2) Try to coerce from text (common “almost a tool”).
  const coerced = coerceFromText(text0, allowed);
  if (coerced) return { text: "", calls: [coerced] };

  // 3) Still invalid → request one strict retry with a precise nudge.
  const nudge = `SYSTEM:
Your response was invalid. Return EITHER
  • one function tool call, OR
  • a concise chat message.

To run a command, call tool "sh" with JSON arguments. Example:
  name: "sh"
  arguments: {"cmd":"ls -la"}

Do not wrap output in special tokens or code fences.`;
  const decision: GuardDecision = { nudge, warnings: ["invalid-output"] };
  return { text: "", calls: [], decision, forceRetry: !args.didRetry };
}

// ---------- helpers ----------
function stripAlienWrappers(text: string): string {
  return String(text ?? "")
    .replace(/<\|[^>]*\|>/g, " ")
    .replace(/^\s*```(?:json|txt|bash)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function containsFileTag(text: string): boolean {
  return /##file\s*:\s*[^\s]+/i.test(text);
}

function normalizeAllowed(toolsAllowed?: readonly string[]): Set<string> | undefined {
  if (!toolsAllowed || toolsAllowed.length === 0) return undefined;
  return new Set(toolsAllowed.map((s) => s.toLowerCase()));
}

function validateCalls(
  calls: ChatToolCall[] | undefined | null,
  allowed?: Set<string>
): { ok: boolean; calls: ChatToolCall[] } {
  if (!calls || calls.length === 0) return { ok: false, calls: [] };

  const out: ChatToolCall[] = [];
  for (const c of calls) {
    if (!c || c.type !== "function") continue;
    const name = String(c.function?.name ?? "").trim();
    if (!name) continue;
    if (allowed && !allowed.has(name.toLowerCase())) continue;

    // Ensure arguments is a JSON string.
    const argStr = normalizeArgString(c.function?.arguments);
    if (argStr == null) continue;

    out.push({
      id: c.id || randomId(),
      type: "function",
      function: { name, arguments: argStr },
    });
  }
  return { ok: out.length > 0, calls: out };
}

function coerceFromText(
  text: string,
  allowed?: Set<string>
): ChatToolCall | null {
  const allow = (name: string) => !allowed || allowed.has(name.toLowerCase());

  // Pull a JSON block from text.
  const j = text.match(/\{[\s\S]*\}/);
  if (j) {
    let payload = j[0];
    if (!payload.includes('"') && payload.includes("'")) {
      payload = payload.replace(/'/g, '"');
    }
    try {
      const obj = JSON.parse(payload);

      // {cmd:"..."} => sh
      if (typeof obj?.cmd === "string" && allow("sh")) {
        return {
          id: randomId(),
          type: "function",
          function: { name: "sh", arguments: JSON.stringify({ cmd: obj.cmd }) },
        };
      }

      // { tool/name:"sh", arguments:{...} }
      const t = obj?.tool ?? obj?.name;
      if (
        typeof t === "string" &&
        obj?.arguments &&
        typeof obj.arguments === "object" &&
        allow(t)
      ) {
        return {
          id: randomId(),
          type: "function",
          function: { name: t, arguments: JSON.stringify(obj.arguments) },
        };
      }
    } catch {
      /* ignore and continue */
    }
  }

  // Fallback: cmd: "..."
  const cmd = text.match(/cmd\s*:\s*["'`](.+?)["'`]/)?.[1];
  if (cmd && allow("sh")) {
    return {
      id: randomId(),
      type: "function",
      function: { name: "sh", arguments: JSON.stringify({ cmd }) },
    };
  }

  return null;
}

function normalizeArgString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return JSON.stringify(v);
  return null;
}

function randomId(): string {
  return "call_" + Math.random().toString(36).slice(2, 10);
}
