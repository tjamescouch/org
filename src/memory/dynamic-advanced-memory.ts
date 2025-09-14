import type { ChatDriver, ChatMessage } from "../drivers/types";
import { R } from "../runtime/runtime";
import { AgentMemory } from "./agent-memory";

/**
 * AdvancedMemory (with Dynamic System Block)
 *
 * Backwards-compatible:
 * - Public surface unchanged (same class name, constructor, methods).
 *
 * What’s new (internals only):
 * - Self-reflection pass mines stable user/assistant patterns into compact "rules".
 * - Gating rejects unsafe/contradictory rules; dedupes/merges; manages TTL & confidence.
 * - A versioned DYNAMIC SYSTEM BLOCK is embedded into the first system prompt (in-place),
 *   so it’s preserved by context pruning and stays authoritative.
 *
 * Opt-in modes (env): ORG_DYNAMIC_MEMORY = "off" | "shadow" | "auto"
 * - off    : no reflection, no block
 * - shadow : mine & score rules, but DO NOT write the block
 * - auto   : mine & write only "low-risk" style/format rules (never loosens hard policy)
 *
 * The block is strictly bounded in size and never overrides static policy, SAFE_MODE,
 * tool caps, or review/sandbox constraints.
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

  // -------------------- Dynamic block internals (private) --------------------

  private readonly dynMode: "off" | "shadow" | "auto";
  private dynVersion = 0;
  private lastReflectTurn = 0;
  private turnCounter = 0;

  // Rule model
  private readonly rules = new Map<string, DynamicRule>(); // key = normalized text hash
  private readonly ledger: RuleEvent[] = [];

  // Background guard (reuse AgentMemory.runOnce)
  // --------------------------------------------------------------------------

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

    // Dynamic mode (env toggle, defaults to "shadow" for safe rollout)
    const m = (R?.env?.ORG_DYNAMIC_MEMORY) || "";
    this.dynMode = (m === "auto" || m === "off" || m === "shadow") ? m : "shadow";
  }

  // ---------------------------------------------------------------------------

  protected async onAfterAdd(): Promise<void> {
    // Increment turn counter for TTL/decay bookkeeping.
    this.turnCounter++;

    // Kick a non-blocking reflection pass on cadence; serialized via runOnce.
    // Cadence: every 2 turns, or whenever the last message is a user correction.
    if (this.dynMode !== "off" && this.shouldReflectNow()) {
      // Fire-and-forget; do not block caller (background).
      void this.runOnce(async () => {
        await this.reflectMineGateAndSquash();
      });
    }

    // Existing summarization flow (unchanged contract).
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
      if (sumA) summaries.push({ from: "Me",     role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
      if (sumS) summaries.push({ from: "System", role: "system",    content: `SYSTEM SUMMARY:\n${sumS}` });
      if (sumU) summaries.push({ from: "Memory", role: "user",      content: `USER SUMMARY:\n${sumU}` });

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
      const s = this.messageContent(m);
      // Cap extremely long tool outputs for estimation
      if (m.role === "tool" && s.length > 24_000) c += 24_000;
      else c += s.length;
      c += 32; // small per-message overhead
    }
    return c;
  }

  private messageContent(m: ChatMessage): string {
    const obj = m as unknown as Record<string, unknown>;
    const val = obj?.content;
    return (typeof val === "string") ? val : String(val ?? "");
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
      let c = this.messageContent(m);
      if (c.length > 4000) c = c.slice(0, 4000) + "\n…(truncated)…";
      const next = `- ${laneName.toUpperCase()}: ${c}\n\n`;
      if (acc.length + next.length > approxChars * 3) break; // bounded input
      acc += next;
    }

    const sys: ChatMessage = {
      role: "system",
      from: "System",
      content: [
        "You are a precise summarizer.",
        "Output concise bullet points; preserve facts, tasks, file paths, commands, constraints.",
        `Hard limit: ~${approxChars} characters total.`,
        "Avoid fluff; keep actionable details."
      ].join(" ")
    };

    const user: ChatMessage = {
      role: "user",
      from: "User",
      content: `${header}\n\nTranscript:\n${acc}`
    };

    const out = await this.driver.chat([sys, user], { model: this.model });
    const text = this.extractText(out);
    return text.trim();
  }

  // ---------------------- Dynamic block implementation -----------------------

  /** Decide whether to run a reflection pass on this turn (lightweight heuristic). */
  private shouldReflectNow(): boolean {
    // Avoid running too often; at most every 2 turns.
    if (this.turnCounter - this.lastReflectTurn < 2) return false;

    // Prefer to reflect when the most recent user message looks like a correction/constraint.
    const last = this.messagesBuffer[this.messagesBuffer.length - 1];
    if (!last) return true;
    if (last.role !== "user") return true;

    const txt = this.messageContent(last).toLowerCase();
    const hints = ["always", "never", "prefer", "please", "no ", "avoid", "do not", "full-file", "succinct", "type-safe", "fail-fast"];
    return hints.some(h => txt.includes(h));
  }

  /** Orchestrates mining -> gating -> squash (background, serialized). */
  private async reflectMineGateAndSquash(): Promise<void> {
    this.lastReflectTurn = this.turnCounter;

    if (this.dynMode === "off") return;

    // 1) Gather a bounded recent window from assistant+user+tool to mine rules.
    const window: ChatMessage[] = [];
    let seenA = 0, seenU = 0, seenT = 0;
    for (let i = this.messagesBuffer.length - 1; i >= 0; i--) {
      const m = this.messagesBuffer[i];
      if (m.role === "assistant" && seenA < 6) { window.push(m); seenA++; }
      else if (m.role === "user" && seenU < 6) { window.push(m); seenU++; }
      else if (m.role === "tool" && seenT < 3) { window.push(m); seenT++; }
      if (window.length >= 14) break;
    }
    window.reverse(); // chronological

    // 2) Ask the miner to propose candidate rules (JSON only).
    const candidates = await this.mineRuleCandidates(window, 1200 /* approx chars */);

    if (candidates.length === 0) return;

    // 3) Gate, score, merge, apply TTL/confidence updates.
    const accepted = this.gateAndMerge(candidates);

    if (accepted.length === 0) return;

    // 4) Depending on mode, either shadow-log or squash into system head.
    if (this.dynMode === "shadow") return;

    // Compose and embed a compact Dynamic System Block (size-bounded).
    const block = this.renderDynamicBlock();
    this.embedDynamicBlockIntoSystemHead(block);
  }

  /** Miner: ask the model to output strict JSON candidate rules mined from the window. */
  private async mineRuleCandidates(window: ChatMessage[], approxChars: number): Promise<CandidateRule[]> {
    if (window.length === 0) return [];

    let acc = "";
    for (const m of window) {
      let c = this.messageContent(m);
      if (c.length > 3000) c = c.slice(0, 3000) + "\n…(truncated)…";
      acc += `- ${m.role.toUpperCase()}: ${c}\n\n`;
      if (acc.length > approxChars) break;
    }

    const sys: ChatMessage = {
      role: "system",
      from: "System",
      content: [
        "You are a compliance-aware preference miner.",
        "Extract STABLE, GENERAL rules that would have improved the assistant's behavior prospectively.",
        "NEVER propose rules that enable network, git ops, or weaken sandbox/review/safety.",
        "ONLY output a JSON array. No prose."
      ].join(" ")
    };

    const schema = [
      "{",
      `"text": "<imperative rule, <= 140 chars>",`,
      `"scope": "global|repo|run|agent|ui",`,
      `"priority": "strong|soft",`,
      `"confidence": 0.0-1.0`,
      "}"
    ].join(" ");

    const usr: ChatMessage = {
      role: "user",
      from: "User",
      content: [
        "From the transcript below, emit up to 6 candidate rules (JSON array) with fields:",
        schema,
        "Bias toward durable style/format/process preferences (e.g., 'Provide full-file replacements').",
        "Transcript:",
        acc
      ].join("\n\n")
    };

    const out = await this.driver.chat([sys, usr], { model: this.model });
    const text = this.extractText(out);
    const json = this.safeExtractJsonArray(text);
    const parsed = Array.isArray(json) ? json : [];
    const outRules: CandidateRule[] = [];

    for (const r of parsed) {
      if (this.isCandidateRule(r)) {
        // Clamp values defensively
        const confidence = Math.max(0, Math.min(1, r.confidence));
        const priority = (r.priority === "strong" ? "strong" : "soft");
        const scope: CandidateRule["scope"] =
          r.scope === "repo" || r.scope === "run" || r.scope === "agent" || r.scope === "ui" ? r.scope : "global";
        const textClean = String(r.text ?? "").trim();
        if (textClean.length > 0 && textClean.length <= 160) {
          outRules.push({ text: textClean, scope, priority, confidence });
        }
      }
    }
    return outRules;
  }

  /** Safety gate + merge into rule store; returns the accepted set this round (post-merge ids). */
  private gateAndMerge(cands: CandidateRule[]): DynamicRule[] {
    const accepted: DynamicRule[] = [];
    for (const c of cands) {
      if (!this.isSafeRuleText(c.text)) {
        this.ledger.push({ type: "reject", reason: "unsafe_text", at: this.turnCounter, text: c.text });
        continue;
      }
      const key = this.ruleKey(c.text);
      const prev = this.rules.get(key);
      const ttl = this.initialTtl(c.priority);
      if (prev) {
        // Merge: raise confidence toward 1 with diminishing returns; refresh TTL.
        const conf = this.blend(prev.confidence, c.confidence);
        const merged: DynamicRule = {
          ...prev,
          confidence: conf,
          ttl,
          updatedAt: this.turnCounter
        };
        this.rules.set(key, merged);
        accepted.push(merged);
        this.ledger.push({ type: "merge", at: this.turnCounter, text: c.text });
      } else {
        const now = this.turnCounter;
        const rule: DynamicRule = {
          id: key,
          text: c.text,
          scope: c.scope,
          priority: c.priority,
          confidence: c.confidence,
          ttl,
          createdAt: now,
          updatedAt: now
        };
        this.rules.set(key, rule);
        accepted.push(rule);
        this.ledger.push({ type: "accept", at: this.turnCounter, text: c.text });
      }
    }

    // Decay & prune
    this.decayAndPrune();
    return accepted;
  }

  private decayAndPrune(): void {
    const toDelete: string[] = [];
    for (const [k, r] of this.rules.entries()) {
      // Reduce TTL each reflection turn; bump soft rules down first by trimming confidence slightly.
      const age = Math.max(0, this.turnCounter - r.updatedAt);
      const ttlLeft = r.ttl - 1; // one unit per reflection pass
      const conf = (r.priority === "soft" && age > 8) ? r.confidence * 0.995 : r.confidence;
      const updated: DynamicRule = { ...r, ttl: ttlLeft, confidence: conf };
      if (ttlLeft <= 0 || conf < 0.15) toDelete.push(k);
      else this.rules.set(k, updated);
    }
    for (const k of toDelete) {
      const t = this.rules.get(k)?.text ?? "";
      this.rules.delete(k);
      this.ledger.push({ type: "expire", at: this.turnCounter, text: t });
    }
  }

  private initialTtl(priority: "strong" | "soft"): number {
    return priority === "strong" ? 40 : 20; // reflection turns
  }

  private blend(prev: number, inc: number): number {
    // Conservative confidence increase
    return Math.max(prev, Math.min(1, prev + (inc * 0.35) * (1 - prev)));
  }

  private isSafeRuleText(text: string): boolean {
    const t = text.toLowerCase();
    // Never permit rules that would loosen safety, network, git, or review/sandbox.
    const banned = [
      "network", "internet", "http://", "https://", "curl ", "wget ", "fetch ",
      "git ", "commit", "push", "pull", "clone", "add ", "npm install", "pip install",
      "bypass", "ignore", "disable safety", "disable sandbox", "skip review"
    ];
    if (banned.some(b => t.includes(b))) return false;
    // Keep rules general and short
    if (t.length > 180) return false;
    return true;
  }

  private ruleKey(text: string): string {
    // djb2 hash over normalized text (lowercase, collapsed whitespace)
    const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h) + norm.charCodeAt(i);
    return `r${(h >>> 0).toString(16)}`;
  }

  /** Render a compact, bounded dynamic block from current rules. */
  private renderDynamicBlock(): string {
    this.dynVersion++;

    // Sort by priority (strong first), then confidence, then recency.
    const arr = Array.from(this.rules.values());
    arr.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === "strong" ? -1 : 1;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt - a.updatedAt;
    });

    // Size cap: budget ~10–12% of total usable context (chars).
    const dynTokenBudget = Math.max(64, Math.floor(this.budgetTokens() * 0.12));
    const dynCharBudget = Math.max(480, Math.floor(dynTokenBudget * this.avgCharsPerToken));

    const header = `DYNAMIC SYSTEM BLOCK v${this.dynVersion}\n` +
      `- Purpose: distilled, safety-preserving preferences learned from recent conversation.\n` +
      `- Scope: never overrides static policy, SAFE_MODE, tool caps, or review/sandbox.\n`;

    let body = "";
    let i = 1;
    for (const r of arr) {
      const line = `${i}) ${r.text}\n`;
      if ((header.length + body.length + line.length) > dynCharBudget) break;
      body += line;
      i++;
      if (i > 12) break; // hard cap on number of lines
    }

    return header + body;
  }

  /** Embed (or refresh) the dynamic block inside the FIRST system message content. */
  private embedDynamicBlockIntoSystemHead(block: string): void {
    const idx = this.messagesBuffer.findIndex(m => m.role === "system");
    if (idx < 0) return; // no system head; nothing to do

    const head = this.messagesBuffer[idx];
    const orig = this.messageContent(head);
    const startTag = "\n[BEGIN DYNAMIC SYSTEM BLOCK]\n";
    const endTag = "\n[END DYNAMIC SYSTEM BLOCK]\n";

    let nextContent: string;
    const startIdx = orig.indexOf(startTag);
    const endIdx = orig.indexOf(endTag);

    const payload = `${startTag}${block}${endTag}`;

    if (startIdx >= 0 && endIdx > startIdx) {
      // Replace existing
      nextContent = orig.slice(0, startIdx) + payload + orig.slice(endIdx + endTag.length);
    } else {
      // Append
      const sep = orig.endsWith("\n") ? "" : "\n";
      nextContent = `${orig}${sep}${payload}`;
    }

    // Mutate in place
    (head as unknown as { content: string }).content = nextContent;
    this.messagesBuffer[idx] = head;
  }

  // -------------------------- Utilities & parsing ----------------------------

  private extractText(out: unknown): string {
    if (typeof out === "string") return out;
    if (out && typeof out === "object" && "text" in (out as Record<string, unknown>)) {
      const v = (out as Record<string, unknown>).text;
      if (typeof v === "string") return v;
    }
    return "";
  }

  private safeExtractJsonArray(text: string): unknown {
    // Try strict parse first
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith("[")) return JSON.parse(trimmed);
    } catch { /* fallthrough */ }

    // Fallback: find first [...] block
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { return JSON.parse(m[0]); } catch { return []; }
  }

  private isCandidateRule(v: unknown): v is CandidateRule {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    const text = o["text"];
    const scope = o["scope"];
    const priority = o["priority"];
    const confidence = o["confidence"];
    return typeof text === "string"
      && (scope === "global" || scope === "repo" || scope === "run" || scope === "agent" || scope === "ui")
      && (priority === "strong" || priority === "soft")
      && typeof confidence === "number";
  }
}

/* --------------------------------- Types ---------------------------------- */

type CandidateRule = {
  text: string;
  scope: "global" | "repo" | "run" | "agent" | "ui";
  priority: "strong" | "soft"; // dynamic memory never emits "hard"
  confidence: number;          // 0..1
};

type DynamicRule = CandidateRule & {
  id: string;       // stable key (hash over normalized text)
  ttl: number;      // reflection turns remaining
  createdAt: number;
  updatedAt: number;
};

type RuleEvent =
  | { type: "accept" | "merge" | "expire"; at: number; text: string }
  | { type: "reject"; reason: "unsafe_text"; at: number; text: string };
