import type { ChatDriver, ChatMessage } from "../drivers/types";
import { AgentMemory } from "./agent-memory";
import { Logger } from "../logger";

/**
 * AdvancedMemory
 *
 * - Summarizes SYSTEM / USER / ASSISTANT lanes independently.
 * - Emits three summaries FIRST in the order: [assistant, system, user, ...rest].
 * - Uses an average characters-per-token to estimate token pressure and compress to target.
 * - Preserves a recent tail per lane and a few recent tool messages for locality.
 *
 * Context budgeting:
 *   contextTokens  : model window (e.g., 8192)
 *   reserveHeader  : system/tool schema + overhead (default 1200)
 *   reserveReply   : space for the model's next reply (default 800)
 *   budget         : contextTokens - reserveHeader - reserveReply
 *   highRatio      : when estimated tokens > highRatio * budget → summarize
 *   lowRatio       : compress so estimated tokens ≤ lowRatio * budget
 *   summaryRatio   : at most this fraction of budget is spent on the 3 summaries combined
 *   avgCharsPerTok : char→token estimate (default 4)
 */
export class AdvancedMemory extends AgentMemory {
  private readonly driver: ChatDriver;
  private readonly model: string;

  // Budget knobs
  private readonly contextTokens: number;
  private readonly reserveHeaderTokens: number;
  private readonly reserveResponseTokens: number;
  private readonly highRatio: number;
  private readonly lowRatio: number;
  private readonly summaryRatio: number;
  private readonly avgCharsPerToken: number;

  // Recency knobs
  private readonly keepRecentPerLane: number;
  private readonly keepRecentTools: number;

  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;

    // Context & budgeting (reasonable defaults for ~8k window)
    contextTokens?: number;         // total window (default 8192)
    reserveHeaderTokens?: number;   // system/tool schema reserve (default 1200)
    reserveResponseTokens?: number; // next reply reserve (default 800)
    highRatio?: number;             // trigger summarization if > 0.70 * budget
    lowRatio?: number;              // compress down to ≤ 0.50 * budget
    summaryRatio?: number;          // at most 0.35 * budget for summaries

    // Estimation & recency
    avgCharsPerToken?: number;      // default 4
    keepRecentPerLane?: number;     // keep last N assistant/user/system msgs (default 4)
    keepRecentTools?: number;       // keep last N tool msgs (default 3)
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

  // --- core hook -------------------------------------------------------------

  protected async onAfterAdd(): Promise<void> {
    // Fast check before any heavy work.
    const budget = this.budgetTokens();
    const estTok = this.estimateTokens(this.messagesBuffer);

    if (estTok <= Math.floor(this.highRatio * budget)) return;

    // Partition messages into lanes; track indices for reconstruction.
    const {
      firstSystemIndex,
      assistant, user, system, tool, other,
      assistantIdx, userIdx, systemIdx, toolIdx, otherIdx
    } = this.partition();

    // Choose "older" slices to summarize + tails to keep.
    const tailN = this.keepRecentPerLane;
    const olderAssistant = assistant.slice(0, Math.max(0, assistant.length - tailN));
    const keepAssistant  = assistant.slice(Math.max(0, assistant.length - tailN));

    // For system, keep the very first system as instructions (if present) no matter what.
    const sysHead = firstSystemIndex === 0 ? [this.messagesBuffer[0]] : [];
    const remainingSystem = firstSystemIndex === 0 ? system.slice(1) : system.slice(0);
    const olderSystem = remainingSystem.slice(0, Math.max(0, remainingSystem.length - tailN));
    const keepSystem  = remainingSystem.slice(Math.max(0, remainingSystem.length - tailN));

    const olderUser = user.slice(0, Math.max(0, user.length - tailN));
    const keepUser  = user.slice(Math.max(0, user.length - tailN));

    const keepTools = tool.slice(Math.max(0, tool.length - this.keepRecentTools));
    // Older tools beyond keepRecentTools are dropped (usually very verbose).

    // Estimate tokens of the *preserved tail + sys head + other + kept tools*
    const preserved: ChatMessage[] = [
      ...sysHead,
      ...keepAssistant, ...keepSystem, ...keepUser,
      ...keepTools,
      ...other,
    ];
    const preservedTok = this.estimateTokens(preserved);

    // Compute target budgets.
    const lowTarget = Math.floor(this.lowRatio * budget);
    const maxSummaryTok = Math.floor(this.summaryRatio * budget);

    // If we can fit without any summaries (very short tails), return early.
    if (preservedTok <= lowTarget) {
      this.messagesBuffer.splice(0, this.messagesBuffer.length,
        ...this.stableOrder([], [], [], preserved, assistantIdx, userIdx, systemIdx, toolIdx, otherIdx)
      );
      return;
    }

    // We must summarize: compute how many tokens we can spend across the 3 summaries.
    const neededSummTok = Math.max(64, Math.min(maxSummaryTok, lowTarget - preservedTok));

    // If still negative (tails alone exceed lowTarget), allow summaries up to maxSummaryTok
    // and accept landing slightly above lowTarget. This prevents over-aggressive truncation.
    const totalSummaryBudget = neededSummTok;

    // Split the summary budget across lanes proportional to the chars removed per lane.
    const removedCharA = this.totalChars(olderAssistant);
    const removedCharS = this.totalChars(olderSystem);
    const removedCharU = this.totalChars(olderUser);
    const removedTotal = Math.max(1, removedCharA + removedCharS + removedCharU);

    const budgetA = Math.max(48, Math.floor(totalSummaryBudget * (removedCharA / removedTotal)));
    const budgetS = Math.max(48, Math.floor(totalSummaryBudget * (removedCharS / removedTotal)));
    const budgetU = Math.max(48, Math.floor(totalSummaryBudget * (removedCharU / removedTotal)));

    // Summarize each lane (skip if there's nothing to summarize).
    const [sumA, sumS, sumU] = await Promise.all([
      olderAssistant.length ? this.summarizeLane("assistant", olderAssistant, budgetA) : "",
      olderSystem.length    ? this.summarizeLane("system",    olderSystem,    budgetS) : "",
      olderUser.length      ? this.summarizeLane("user",      olderUser,      budgetU) : "",
    ]);

    const summaryMessages: ChatMessage[] = [];
    if (sumA) summaryMessages.push({ role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
    if (sumS) summaryMessages.push({ role: "system",    content: `SYSTEM SUMMARY:\n${sumS}` });
    if (sumU) summaryMessages.push({ role: "user",      content: `USER SUMMARY:\n${sumU}` });

    // Rebuild buffer: [assistant-summary, system-summary, user-summary, ...rest]
    const rebuilt = this.stableOrder(
      summaryMessages,
      // older items are removed; keep tails, sys head, tools, others in chronological order
      sysHead, keepAssistant, keepSystem, keepUser, keepTools, other,
      assistantIdx, userIdx, systemIdx, toolIdx, otherIdx
    );

    this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

    // Optional final clamp: if still over lowTarget (because tails/tools were huge),
    // drop the oldest non-system items until we are below target.
    let finalTok = this.estimateTokens(this.messagesBuffer);
    if (finalTok > lowTarget) {
      const pruned: ChatMessage[] = [];
      for (const m of this.messagesBuffer) {
        pruned.push(m);
        finalTok = this.estimateTokens(pruned);
        if (finalTok > lowTarget) {
          // try to drop oldest non-system (avoid dropping assistant/system summaries)
          const idx = pruned.findIndex(x => x.role !== "system"); // keep early system msgs
          if (idx >= 0) pruned.splice(idx, 1);
        }
      }
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...pruned);
    }
  }

  // --- helpers ---------------------------------------------------------------

  private budgetTokens(): number {
    return Math.max(
      512,
      this.contextTokens - this.reserveHeaderTokens - this.reserveResponseTokens
    );
  }

  private estimateTokens(msgs: ChatMessage[]): number {
    const totalChars = this.totalChars(msgs);
    return Math.ceil(totalChars / this.avgCharsPerToken);
  }

  private totalChars(msgs: ChatMessage[]): number {
    let c = 0;
    for (const m of msgs) {
      const s = String((m as any).content ?? "");
      // cap extremely long tool outputs at a high watermark for estimation
      if (m.role === "tool" && s.length > 24_000) c += 24_000;
      else c += s.length;
      // tiny overhead per message for role/metadata
      c += 32;
    }
    return c;
  }

  /** Split buffer into lanes and remember indices for chronological rebuild. */
  private partition() {
    const assistant: ChatMessage[] = [];
    const user: ChatMessage[] = [];
    const system: ChatMessage[] = [];
    const tool: ChatMessage[] = [];
    const other: ChatMessage[] = [];

    const assistantIdx: number[] = [];
    const userIdx: number[] = [];
    const systemIdx: number[] = [];
    const toolIdx: number[] = [];
    const otherIdx: number[] = [];

    const msgs = this.messagesBuffer;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      switch (m.role) {
        case "assistant": assistant.push(m); assistantIdx.push(i); break;
        case "user":      user.push(m);      userIdx.push(i); break;
        case "system":    system.push(m);    systemIdx.push(i); break;
        case "tool":      tool.push(m);      toolIdx.push(i); break;
        default:          other.push(m);     otherIdx.push(i); break;
      }
    }

    const firstSystemIndex = systemIdx.length ? systemIdx[0] : -1;

    return { firstSystemIndex, assistant, user, system, tool, other,
             assistantIdx, userIdx, systemIdx, toolIdx, otherIdx };
  }

  /**
   * Build the final message order:
   *   [ summaries in required order ], followed by the preserved/rest in original chronology.
   * We rebuild "rest" by iterating original order and selecting from the provided keep-sets.
   */
  // Overload signature 1: only rest
  private stableOrder(
    summaries: ChatMessage[],
    preservedOnly: ChatMessage[],
    assistantIdx?: number[], userIdx?: number[], systemIdx?: number[], toolIdx?: number[], otherIdx?: number[]
  ): ChatMessage[];
  // Overload signature 2: detailed components
  private stableOrder(
    summaries: ChatMessage[],
    sysHead: ChatMessage[], keepA?: ChatMessage[], keepS?: ChatMessage[], keepU?: ChatMessage[],
    keepT?: ChatMessage[], other?: ChatMessage[],
    assistantIdx?: number[], userIdx?: number[], systemIdx?: number[], toolIdx?: number[], otherIdx?: number[]
  ): ChatMessage[];
  private stableOrder(
    summaries: ChatMessage[],
    arg2: ChatMessage[] = [],
    arg3?: ChatMessage[] | number[], arg4?: ChatMessage[] | number[], arg5?: ChatMessage[] | number[],
    arg6?: ChatMessage[] | number[], arg7?: ChatMessage[] | number[],
    arg8?: number[], arg9?: number[], arg10?: number[], arg11?: number[]
  ): ChatMessage[] {
    // If called with (summaries, preservedOnly)
    if (Array.isArray(arg3) === false && Array.isArray(arg4) === false && Array.isArray(arg5) === false) {
      return [...summaries, ...arg2];
    }

    const sysHead = arg2 as ChatMessage[];
    const keepA = arg3 as ChatMessage[] || [];
    const keepS = arg4 as ChatMessage[] || [];
    const keepU = arg5 as ChatMessage[] || [];
    const keepT = arg6 as ChatMessage[] || [];
    const other = arg7 as ChatMessage[] || [];

    const aSet = new Set(keepA);
    const sSet = new Set(keepS.concat(sysHead));
    const uSet = new Set(keepU);
    const tSet = new Set(keepT);
    const oSet = new Set(other);

    const rebuilt: ChatMessage[] = [];
    // 1) required summaries order: ASSISTANT → SYSTEM → USER
    for (const sm of summaries) {
      if (sm.role === "assistant" || sm.role === "system" || sm.role === "user") rebuilt.push(sm);
    }

    // 2) then rest in original chronology (we iterate the original buffer).
    for (const m of this.messagesBuffer) {
      if (sSet.has(m) || aSet.has(m) || uSet.has(m) || tSet.has(m) || oSet.has(m)) {
        rebuilt.push(m);
      }
    }

    return rebuilt;
  }

  private async summarizeLane(
    laneName: "assistant" | "system" | "user",
    messages: ChatMessage[],
    tokenBudget: number
  ): Promise<string> {
    if (messages.length === 0) return "";
    const approxChars = Math.max(120, Math.floor(tokenBudget * this.avgCharsPerToken));
    const header = (() => {
      switch (laneName) {
        case "assistant": return "Summarize prior ASSISTANT replies (decisions, plans, code changes, commands, file edits).";
        case "system":    return "Summarize SYSTEM instructions (rules, goals, constraints, style) without changing intent.";
        case "user":      return "Summarize USER requests, feedback, constraints, acceptance criteria.";
      }
    })();

    const transcript = messages.map((m, i) => {
      let c = String((m as any).content ?? "");
      if (c.length > 4000) c = c.slice(0, 4000) + "\n…(truncated)…";
      return `${i + 1}. ${laneName.toUpperCase()}: ${c}`;
    }).join("\n\n");

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
      content: `${header}\n\nTranscript:\n${transcript}`
    };

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = (out as any)?.text ?? "";
    return String(text || "").trim();
  }
}
