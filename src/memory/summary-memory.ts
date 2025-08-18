import type { ChatDriver, ChatMessage } from "../drivers/types";
import { AgentMemory } from "./agent-memory";

/**
 * SummaryMemory
 *
 * Hysteresis-based memory:
 *   - When message count (excluding the initial system prompt) exceeds HIGH,
 *     we summarize the oldest K messages into a single system "summary" message,
 *     choosing K so that the new count becomes LOW.
 *
 * Notes:
 *   - We keep the *first* message if it's a system prompt.
 *   - The summary is inserted as a system message placed after the (original)
 *     first system prompt, so instructions remain on top and the summary follows.
 */
export class SummaryMemory extends AgentMemory {
  private readonly driver: ChatDriver;
  private readonly model: string;
  private readonly highWatermark: number;
  private readonly lowWatermark: number;

  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;
    highWatermark?: number; // trigger summarize when strictly greater
    lowWatermark?: number;  // reduce down to this count
  }) {
    super(args.systemPrompt);
    this.driver = args.driver;
    this.model = args.model;
    this.highWatermark = Math.max(8, args.highWatermark ?? 48);
    this.lowWatermark = Math.max(4, Math.min(args.lowWatermark ?? 32, this.highWatermark - 2));
  }

  protected async onAfterAdd(): Promise<void> {
    const nonSys = this.nonSystemCount();
    if (nonSys <= this.highWatermark) return;

    // We want to reduce non-system messages down to lowWatermark by replacing
    // the oldest K messages with a single summary message.
    const target = this.lowWatermark;
    const current = nonSys;
    const reduceBy = current - target; // D >= 1
    const K = Math.max(1, reduceBy + 1); // replace K msgs with 1 → net -D

    // Identify slice to summarize:
    // index 0 may be a system prompt; summarize starting at idx=1 (or 0 if not system).
    const start = this.messagesBuffer.length > 0 && this.messagesBuffer[0].role === "system" ? 1 : 0;
    const end = Math.min(this.messagesBuffer.length, start + K);
    const toSummarize = this.messagesBuffer.slice(start, end);

    const summaryText = await this.summarizeMessages(toSummarize);

    const summaryMsg: ChatMessage = {
      role: "system",
      content: [
        "CONTEXT SUMMARY (older messages compressed):",
        summaryText.trim()
      ].join("\n\n")
    };

    // Replace [start, end) with the single summary message.
    this.messagesBuffer.splice(start, end - start, summaryMsg);
  }

  /**
   * Summarize a slice of messages using the same driver/model as the agent.
   * We send a compact instruction + concatenated transcript.
   */
  private async summarizeMessages(block: ChatMessage[]): Promise<string> {
    const asText = block.map((m, i) => {
      const role = m.role || "assistant";
      // tool messages can be noisy JSON; keep them short
      let content = String((m as any).content ?? "");
      if (role === "tool" && content.length > 1200) {
        content = content.slice(0, 1200) + "\n…(truncated tool output)…";
      }
      return `${i + 1}. ${role.toUpperCase()}: ${content}`;
    }).join("\n\n");

    const sys = {
      role: "system",
      content:
        "You are a precise summarizer. Produce a compact summary of the provided chat transcript that preserves: decisions, tasks, file names and contents (high level), command results, constraints, and open questions. No fluff. 200–300 words max."
    } as ChatMessage;

    const user = {
      role: "user",
      content:
        "Summarize the following messages:\n\n" + asText
    } as ChatMessage;

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = (out as any)?.text ?? "";
    return String(text || "").trim() || "(no summary produced)";
  }
}
