import type { ChatDriver, ChatMessage } from "../drivers/types";
import { Role } from "../types";
import { AgentMemory } from "./agent-memory";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) console.error("[DBG][SummaryMemory]", ...a); }

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

      const target = this.lowWatermark;
      const current = this.nonSystemCount();
      const reduceBy = current - target;
      const K = Math.max(1, reduceBy + 1);

      const start = this.messagesBuffer.length > 0 && this.messagesBuffer[0].role === "system" ? 1 : 0;
      const end = Math.min(this.messagesBuffer.length, start + K);
      const toSummarize = this.messagesBuffer.slice(start, end);

      dbg(`summarizing ${toSummarize.length} messages…`);
      const summaryText = await this.summarizeMessages(toSummarize);
      dbg(`summary produced (len=${summaryText.length})`);

      const summaryMsg: ChatMessage = {
        role: "system",
        content: `CONTEXT SUMMARY:\n${summaryText}`.trim()
      };

      this.messagesBuffer.splice(start, end - start, summaryMsg);
    });
  }

  protected async summarizeMessages(block: ChatMessage[]): Promise<string> {
    // Bound input size so prompts stay quick.
    const MAX_TOTAL_CHARS = 8_000;
    let total = 0;
    const parts: string[] = [];
    for (const m of block) {
      const role = m.role || "assistant";
      let content = String((m as any).content ?? "");
      if (role === "tool" && content.length > 1200) content = content.slice(0, 1200) + "\n…(truncated tool output)…";
      const frag = `${role.toUpperCase()}: ${content}`;
      if (total + frag.length > MAX_TOTAL_CHARS) break;
      parts.push(frag);
      total += frag.length;
    }
    const asText = parts.join("\n\n");

    const sys = {
      role: "system",
      from: "System",
      content:
        "You are a precise summarizer. Produce a compact summary preserving decisions, tasks, file paths, command results, constraints, and open questions. 150–250 words."
    };

    const user = { role: "user", content: "Summarize the following messages:\n\n" + asText, from: "User" };

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = (out as any)?.text ?? "";
    return String(text || "").trim() || "(no summary produced)";
  }
}
