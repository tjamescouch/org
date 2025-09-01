/**
 * Post‑assistant routing decision helper.
 *
 * The scheduler should call this **once the assistant stream is finished**
 * with the exact text that would be printed to the console after all
 * streaming filters. The rule is intentionally simple and deterministic:
 *
 * - If the assistant’s final text contains a top‑level `@@user` (or `@@group`)
 *   tag outside of code fences, we **yield to the user** (open the prompt)
 *   and do NOT schedule another agent step.
 * - Otherwise, if there’s a single top‑level `@@<agent>` tag (outside fences)
 *   we may continue to that agent (the scheduler can decide whether to do so).
 * - Code fences are respected; tags inside fenced blocks are ignored.
 *
 * This file is pure/side‑effect free; it’s easy to unit‑test and cheap to call.
 */

export type PostAssistantDecision = {
  /** Open the user prompt and end the agent’s turn. */
  yieldToUser: boolean;

  /**
   * If present and `yieldToUser` is false, this is the suggested next agent
   * to schedule (derived from a top‑level @@<agent> tag). The scheduler may
   * still choose to ignore it based on its own policy.
   */
  continueWith?: string | null;
};

/** Internal: quick scan for a top‑level `@@token` at the start of the line. */
function readTopLevelTag(line: string): string | null {
  // Allow optional leading whitespace, but only at the same line level
  // (we are not inside a code fence when this runs).
  const m = line.match(/^\s*@@([A-Za-z0-9_-]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** Internal: recognize fenced code blocks ```lang ... ``` (backtick fences). */
function isFenceMarker(line: string): boolean {
  // leading backticks only; ignore inline code spans.
  return /^\s*```/.test(line);
}

/**
 * Decide what the scheduler should do after the assistant finishes.
 * @param finalText The assistant's final, user-visible text.
 */
export function decidePostAssistantAction(finalText: string): PostAssistantDecision {
  let inFence = false;
  const topLevelTags: string[] = [];

  // Normalize newlines and walk line by line.
  const lines = finalText.replace(/\r\n?/g, "\n").split("\n");

  for (const raw of lines) {
    const line = raw || "";

    // Toggle code-fence state; tags inside fences don’t count.
    if (isFenceMarker(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const tag = readTopLevelTag(line);
    if (tag) topLevelTags.push(tag);
  }

  // Yield if the user (or group) is addressed anywhere at top-level.
  if (topLevelTags.includes("user") || topLevelTags.includes("group")) {
    return { yieldToUser: true, continueWith: null };
  }

  // Otherwise, suggest continuing if we see a single specific agent tag.
  // Ignore common non-targets.
  const ignore = new Set(["assistant", "tool", "tools", "system"]);
  const next = topLevelTags.find((t) => !ignore.has(t)) ?? null;

  return { yieldToUser: false, continueWith: next };
}
