// src/core/summarizer.ts
//
// Provides a naive summarization utility for chat history.  This module
// deliberately avoids calling external language models so that it can run
// locally in environments without network access.  The summarizer simply
// concatenates the most recent messages and truncates the output to a
// reasonable length.

import type { ChatMessage } from "../types";

/**
 * Summarize a sequence of chat messages by concatenating the last few
 * messages together.  Only the `content` field of each message is used.
 * The returned string will not exceed the specified maximum length.
 *
 * @param messages Full chat history to summarize.
 * @param maxMessages Number of trailing messages to include in the summary.
 * @param maxLength Maximum length of the returned summary string.
 */
export function summarizeHistory(
  messages: ChatMessage[],
  maxMessages: number = 6,
  maxLength: number = 200
): string {
  // Determine which portion of the history to include in the summary.  When the
  // requested window size is smaller than the total number of messages,
  // exclude the most recent message and instead include the previous
  // `maxMessages` messages.  This mirrors how context summaries are used
  // to summarise prior conversation history while omitting the latest
  // assistant response.  If there are fewer than or equal to `maxMessages`
  // messages, include all of them.
  let tail: ChatMessage[];
  const n = Math.max(0, maxMessages);
  if (messages.length <= n) {
    // Include all messages when history is short.
    tail = messages.slice();
  } else {
    // Exclude the most recent message and include the preceding n messages.
    const start = Math.max(0, messages.length - n - 1);
    const end = messages.length - 1;
    tail = messages.slice(start, end);
  }
  let summary = tail
    .map(m => (m.content ?? "").toString())
    .filter(Boolean)
    .join(" | ");
  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength) + "…";
  }
  return summary;
}

export default summarizeHistory;
