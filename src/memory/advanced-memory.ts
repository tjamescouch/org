import type { ChatDriver, ChatMessage } from "../drivers/types";
import { AgentMemory } from "./agent-memory";

/**
 * AdvancedMemory
 *
 * - Maintains three “swim lanes” (assistant / system / user) and summarizes them independently.
 * - Emits summaries FIRST in the required order: [assistant, system, user, ...rest].
 * - Uses an average characters-per-token estimate to keep the total context near a target budget
 *   derived from the model’s context window (with reserves for headers/next reply).
 * - Preserves a small recent tail from each lane and a few recent tool outputs.
 * - Background summarization (serialized); never blocks the caller of add().
 */
export class AdvancedMemory extends AgentMemory {
  private readonly driver: ChatDriver;
  private readonly model: string;

  // Context budgeting knobs
  private readonly contextTokens: number;
  private readonly reserveHeaderTokens: number;
  private readonly reserveResponseTokens: number;
  private readonly highRatio: number;     // trigger summarization when est > highRatio * budget
  private readonly lowRatio: number;      // compress to <= lowRatio * budget
  private readonly summaryRatio: number;  // max fraction of budget for the 3 summaries combined
  private readonly avgCharsPerToken: number;

  // Recency knobs
  private readonly keepRecentPerLane: number; // keep last N assistant/user/system msgs
  private readonly keepRecentTools: number;   // keep last N tool msgs

  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;

    contextTokens?: number;         // default 8192
    reserveHeaderTokens?: number;   // default 1200
    reserveResponseTokens?: number; // default 800
    highRatio?: number;             // default 0.70
    lowRatio?: number;              // default 0.50
    summaryRatio?: number;          // default 0.35
    avgCharsPerToken?: number;      // default 4
    keepRecentPerLane?: number;     // default 4
    keepRecentTools?: number;       // default 3
  }) {
    super(args.systemPrompt);
    this.driver = args.driver;
    this.model = args.model;

    this.contextTokens = Math.max(2048, Math.floor(args.contextTokens ?? 8192));
    this.reserveHeaderTokens = Math.max(0, Math.floor(args.reserveHeaderTokens ?? 1200));
    this.reserveResponseTokens = Math.max(0, Math.floor(args.reserveResponseTokens ?? 800));
    this.highRatio = Math.min(0.95, Math.max(0.55, args.highRatio ?? 0.70));
    this.lowRatio  = Math.min(this.highRatio - 0.05, Math.max(0.35, args.lowRatio ?? 0.50));
    this.summaryRatio = Math.min(0.50, Math.max(0.15, args.summaryRatio ?? 0.35));

    this.avgCharsPerToken = Math.max(1.5, Number(args.avgCharsPerToken ?? 4));
    this.keepRecentPerLane = Math.max(1, Math.floor(args.keepRecentPerLane ?? 4));
    this.keepRecentTools   = Math.max(0, Math.floor(args.keepRecentTools ?? 3));
  }

  // ---------------------------------------------------------------------------

  protected async onAfterAdd(): Promise<void> {
    const budget = this.budgetTokens();
    const estTok = this.estimateTokens(this.messagesBuffer);
    if (estTok <= Math.floor(this.highRatio * budget)) return;

    // Serialize summarization; do not block caller.
    await this.runOnce(async () => {
      // Recompute at execution time (history may have changed).
      const budget2 = this.budgetTokens();
      const estTok2 = this.estimateTokens(this.messagesBuffer);
      if (estTok2 <= Math.floor(this.highRatio * budget2)) return;

      const {
        firstSystemIndex,
        assistant, user, system, tool, other,
      } = this.partition();

      const tailN = this.keepRecentPerLane;

      const olderAssistant = assistant.slice(0, Math.max(0, assistant.length - tailN));
      const keepAssistant  = assistant.slice(Math.max(0, assistant.length - tailN));

      const sysHead = firstSystemIndex === 0 ? [this.messagesBuffer[0]] : [];
      const remainingSystem = firstSystemIndex === 0 ? system.slice(1) : system.slice(0);
      const olderSystem = remainingSystem.slice(0, Math.max(0, remainingSystem.length - tailN));
      const keepSystem  = remainingSystem.slice(Math.max(0, remainingSystem.length - tailN));

      const olderUser = user.slice(0, Math.max(0, user.length - tailN));
      const keepUser  = user.slice(Math.max(0, user.length - tailN));

      const keepTools = tool.slice(Math.max(0, tool.length - this.keepRecentTools));

      // Tokens cost of preserved (tails + sys head + a few tools + others)
      const preserved: ChatMessage[] = [
        ...sysHead, ...keepAssistant, ...keepSystem, ...keepUser, ...keepTools, ...other
      ];
      const preservedTok = this.estimateTokens(preserved);

      const lowTarget = Math.floor(this.lowRatio * budget2);
      const maxSummaryTok = Math.floor(this.summaryRatio * budget2);

      // If tails alone fit, rebuild w/out summaries (just reorder preserved)
      if (preservedTok <= lowTarget) {
        const rebuilt = this.ordered(
          [], sysHead, keepAssistant, keepSystem, keepUser, keepTools, other
        );
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);
        return;
      }

      // We need summaries. Allocate summary budget across lanes proportionally
      // to the chars we removed from each lane.
      const removedCharA = this.totalChars(olderAssistant);
      const removedCharS = this.totalChars(olderSystem);
      const removedCharU = this.totalChars(olderUser);
      const removedTotal = Math.max(1, removedCharA + removedCharS + removedCharU);

      const totalSummaryBudget = Math.max(64, Math.min(maxSummaryTok, lowTarget - preservedTok));
      const budgetA = Math.max(48, Math.floor(totalSummaryBudget * (removedCharA / removedTotal)));
      const budgetS = Math.max(48, Math.floor(totalSummaryBudget * (removedCharS / removedTotal)));
      const budgetU = Math.max(48, Math.floor(totalSummaryBudget * (removedCharU / removedTotal)));

      const [sumA, sumS, sumU] = await Promise.all([
        olderAssistant.length ? this.summarizeLane("assistant", olderAssistant, budgetA) : "",
        olderSystem.length    ? this.summarizeLane("system",    olderSystem,    budgetS) : "",
        olderUser.length      ? this.summarizeLane("user",      olderUser,      budgetU) : "",
      ]);

      const summaries: ChatMessage[] = [];
      if (sumA) summaries.push({ role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
      if (sumS) summaries.push({ role: "system",    content: `SYSTEM SUMMARY:\n${sumS}` });
      if (sumU) summaries.push({ role: "user",      content: `USER SUMMARY:\n${sumU}` });

      const rebuilt = this.ordered(
        summaries, sysHead, keepAssistant, keepSystem, keepUser, keepTools, other
      );
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

      // Final clamp if still above target (drop oldest non-system until under target)
      let finalTok = this.estimateTokens(this.messagesBuffer);
      if (finalTok > lowTarget) {
        const pruned: ChatMessage[] = [];
        for (const m of this.messagesBuffer) {
          pruned.push(m);
          finalTok = this.estimateTokens(pruned);
          if (finalTok > lowTarget && m.role !== "system") {
            pruned.pop();
          }
        }
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...pruned);
      }
    });
  }

  // ---------------------------------------------------------------------------

  private budgetTokens(): number {
    return Math.max(
      512,
      this.contextTokens - this.reserveHeaderTokens - this.reserveResponseTokens
    );
  }

  private estimateTokens(msgs: ChatMessage[]): number {
    return Math.ceil(this.totalChars(msgs) / this.avgCharsPerToken);
  }

  private totalChars(msgs: ChatMessage[]): number {
    let c = 0;
    for (const m of msgs) {
      const s = String((m as any).content ?? "");
      // Cap extremely long tool outputs for estimation
      if (m.role === "tool" && s.length > 24_000) c += 24_000;
      else c += s.length;
      c += 32; // small per-message overhead
    }
    return c;
  }

  private partition() {
    const assistant: ChatMessage[] = [];
    const user: ChatMessage[] = [];
    const system: ChatMessage[] = [];
    const tool: ChatMessage[] = [];
    const other: ChatMessage[] = [];

    for (const m of this.messagesBuffer) {
      switch (m.role) {
        case "assistant": assistant.push(m); break;
        case "user":      user.push(m); break;
        case "system":    system.push(m); break;
        case "tool":      tool.push(m); break;
        default:          other.push(m); break;
      }
    }
    const firstSystemIndex = this.messagesBuffer.findIndex(x => x.role === "system");
    return { firstSystemIndex, assistant, user, system, tool, other };
  }

  /** Build final order: [assistant-summary, system-summary, user-summary, ...chronological rest] */
  private ordered(
    summaries: ChatMessage[],
    sysHead: ChatMessage[],
    keepA: ChatMessage[],
    keepS: ChatMessage[],
    keepU: ChatMessage[],
    keepT: ChatMessage[],
    other: ChatMessage[],
  ): ChatMessage[] {
    const rest: ChatMessage[] = [];
    const keepSet = new Set([...sysHead, ...keepA, ...keepS, ...keepU, ...keepT, ...other]);
    for (const m of this.messagesBuffer) {
      if (keepSet.has(m)) rest.push(m);
    }
    // prepend summaries in required order
    const orderedSummaries = [
      ...summaries.filter(s => s.role === "assistant"),
      ...summaries.filter(s => s.role === "system"),
      ...summaries.filter(s => s.role === "user"),
    ];
    return [...orderedSummaries, ...rest];
  }

  private async summarizeLane(
    laneName: "assistant" | "system" | "user",
    messages: ChatMessage[],
    tokenBudget: number
  ): Promise<string> {
    if (messages.length === 0 || tokenBudget <= 0) return "";
    const approxChars = Math.max(120, Math.floor(tokenBudget * this.avgCharsPerToken));

    const header = (() => {
      switch (laneName) {
        case "assistant": return "Summarize prior ASSISTANT replies (decisions, plans, code edits, shell commands and outcomes).";
        case "system":    return "Summarize SYSTEM instructions (rules, goals, constraints) without changing their intent.";
        case "user":      return "Summarize USER requests, feedback, constraints, and acceptance criteria.";
      }
    })();

    // Cap total transcript length used for summarization to avoid slow prompts.
    let acc = "";
    for (const m of messages) {
      let c = String((m as any).content ?? "");
      if (c.length > 4000) c = c.slice(0, 4000) + "\n…(truncated)…";
      const next = `- ${laneName.toUpperCase()}: ${c}\n\n`;
      if (acc.length + next.length > approxChars * 3) break; // bounded input
      acc += next;
    }

    const sys: ChatMessage = {
      role: "system",
      content: [
        "You are a precise summarizer.",
        "Output concise bullet points; preserve facts, tasks, file paths, commands, constraints.",
        `Hard limit: ~${approxChars} characters total.`,
        "Avoid fluff; keep actionable details."
      ].join(" ")
    };

    const user: ChatMessage = {
      role: "user",
      content: `${header}\n\nTranscript:\n${acc}`
    };

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = (out as any)?.text ?? "";
    return String(text || "").trim();
  }
}
