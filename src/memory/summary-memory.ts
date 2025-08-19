import type { ChatDriver, ChatMessage } from "../drivers/types";
import { AgentMemory } from "./agent-memory";

/**
 * Count-based hysteresis memory with background summarization.
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
    highWatermark?: number;
    lowWatermark?: number;
  }) {
    super(args.systemPrompt);
    this.driver = args.driver;
    this.model = args.model;
    this.highWatermark = Math.max(8, args.highWatermark ?? 48);
    this.lowWatermark  = Math.max(4, Math.min(args.lowWatermark ?? 32, this.highWatermark - 2));
  }

  protected async onAfterAdd(): Promise<void> {
    if (this.nonSystemCount() <= this.highWatermark) return;
    await this.runOnce(async () => {
      if (this.nonSystemCount() <= this.highWatermark) return;

      // Replace oldest K messages with a summary to reduce to low watermark.
      const target = this.lowWatermark;
      const current = this.nonSystemCount();
      const reduceBy = current - target;
      const K = Math.max(1, reduceBy + 1);

      const start = this.messagesBuffer.length > 0 && this.messagesBuffer[0].role === "system" ? 1 : 0;
      const end = Math.min(this.messagesBuffer.length, start + K);
      const toSummarize = this.messagesBuffer.slice(start, end);

      const summaryText = await this.summarizeMessages(toSummarize);

      const summaryMsg: ChatMessage = {
        role: "system",
        content: `CONTEXT SUMMARY:\n${summaryText}`.trim()
      };

      this.messagesBuffer.splice(start, end - start, summaryMsg);
    });
  }

  protected async summarizeMessages(block: ChatMessage[]): Promise<string> {
    const asText = block.map((m, i) => {
      const role = m.role || "assistant";
      let content = String((m as any).content ?? "");
      if (role === "tool" && content.length > 1200) {
        content = content.slice(0, 1200) + "\n…(truncated tool output)…";
      }
      return `${i + 1}. ${role.toUpperCase()}: ${content}`;
    }).join("\n\n");

    const sys = { role: "system", content:
      "You are a precise summarizer. Produce a compact summary of the provided chat transcript that preserves decisions, tasks, file names, command results, constraints, and open questions. 150–250 words."
    } as ChatMessage;

    const user = { role: "user", content: "Summarize the following messages:\n\n" + asText } as ChatMessage;

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = (out as any)?.text ?? "";
    return String(text || "").trim() || "(no summary produced)";
  }
}
