import type { ChatDriver, ChatMessage } from "../drivers/types";
import { R } from "../runtime/runtime";
import { AgentMemory } from "./agent-memory";
import { MemoryPersisitence } from "./memory-persistence";
import path from 'path';


/**
 * DynamicAdvancedMemory (v2)
 *
 * A backward-compatible memory with a *reflective persona*:
 * - Periodically distills recent dialogue (any language) into a compact
 *   "Dynamic Persona Block" (roles, style, heuristics, anti-goals).
 * - Appends or refreshes that block inside the FIRST system message.
 * - Keeps the original lane summarization & budgeting logic intact.
 *
 * Modes (env OR constructor):
 *   off    → no reflection, no persona block
 *   shadow → mine/merge persona internally but DO NOT write to system lane
 *   auto   → mine/merge and write the persona block (bounded, safe)
 *
 * Safety:
 * - Persona can NEVER override static policy, SAFE_MODE, tool caps, or review.
 * - No network/git enabling, no sandbox weakening—guarded in merge/render.
 *
 * Cadence:
 * - Reflection is time-based, not keyword-triggered (language-agnostic).
 * - Default: every 3 turns (min gap), window-capped; single LLM call per pass.
 */


type PersistedState = { 
  version: number; 
  persona: unknown; 
  ledger: unknown;
  messagesBuffer: any[];
};

export class DynamicAdvancedMemory extends AgentMemory {
  private readonly driver: ChatDriver;
  private readonly model: string;

  // Context budgeting knobs (unchanged from AdvancedMemory defaults)
  private readonly contextTokens: number;
  private readonly reserveHeaderTokens: number;
  private readonly reserveResponseTokens: number;
  private readonly highRatio: number;     // summarize when est > highRatio * budget
  private readonly lowRatio: number;      // compress to <= lowRatio * budget
  private readonly summaryRatio: number;  // fraction of budget reserved for 3 lane summaries
  private readonly avgCharsPerToken: number;

  // Recency knobs
  private readonly keepRecentPerLane: number; // keep last N assistant/user/system msgs
  private readonly keepRecentTools: number;   // keep last N tool msgs

  // ------------------ Reflective Persona (v2) configuration ------------------

  private readonly dynMode: "off" | "shadow" | "auto";
  private readonly minReflectGapTurns: number;       // default 3
  private readonly reflectWindowMaxMsgs: number;     // default 16 (total mixed)
  private readonly personaTokenFraction: number;     // default 0.12 of usable budget
  private readonly personaMaxLines: number;          // default 12
  private readonly decayPerPass: number;             // default 0.03 (3%)
  private readonly minKeepWeight: number;            // default 0.22
  private readonly mergeAggressiveness: number;      // default 0.60 (how strongly new evidence bumps)
  private readonly store:MemoryPersisitence<PersistedState>;

  private turnCounter = 0;
  private lastReflectTurn = 0;
  private persona: PersonaModel = {
    version: 0,
    lastUpdatedTurn: 0,
    roles: [],
    style: [],
    heuristics: [],
    antigoals: [],
    languages: []
  };

  private ledger: PersonaEvent[] = [];


  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;

    // Context / summarization knobs (same defaults as prior class)
    contextTokens?: number;         // default 8192
    reserveHeaderTokens?: number;   // default 1200
    reserveResponseTokens?: number; // default 800
    highRatio?: number;             // default 0.70
    lowRatio?: number;              // default 0.50
    summaryRatio?: number;          // default 0.35
    avgCharsPerToken?: number;      // default 4
    keepRecentPerLane?: number;     // default 4
    keepRecentTools?: number;       // default 3

    // v2 reflective persona knobs (all defaulted)
    dynMode?: "off" | "shadow" | "auto";
    minReflectGapTurns?: number;       // default 3
    reflectWindowMaxMsgs?: number;     // default 16
    personaTokenFraction?: number;     // default 0.12
    personaMaxLines?: number;          // default 12
    decayPerPass?: number;             // default 0.03
    minKeepWeight?: number;            // default 0.22
    mergeAggressiveness?: number;      // default 0.60
  }) {
    super(args.systemPrompt);
    this.driver = args.driver;
    this.model = args.model;

    // Original budgeting defaults
    this.contextTokens = Math.max(2048, Math.floor(args.contextTokens ?? 8192));
    this.reserveHeaderTokens = Math.max(0, Math.floor(args.reserveHeaderTokens ?? 1200));
    this.reserveResponseTokens = Math.max(0, Math.floor(args.reserveResponseTokens ?? 800));
    this.highRatio = Math.min(0.95, Math.max(0.55, args.highRatio ?? 0.70));
    this.lowRatio  = Math.min(this.highRatio - 0.05, Math.max(0.35, args.lowRatio ?? 0.50));
    this.summaryRatio = Math.min(0.50, Math.max(0.15, args.summaryRatio ?? 0.35));

    this.avgCharsPerToken = Math.max(1.5, Number(args.avgCharsPerToken ?? 4));
    this.keepRecentPerLane = Math.max(1, Math.floor(args.keepRecentPerLane ?? 4));
    this.keepRecentTools   = Math.max(0, Math.floor(args.keepRecentTools ?? 3));

    // v2 persona defaults (env can override dynMode)
    const envMode = (R.env?.ORG_DYNAMIC_MEMORY) || "";
    const mode: "off" | "shadow" | "auto" =
      args.dynMode ?? ((envMode === "off" || envMode === "shadow" || envMode === "auto") ? envMode : "shadow");
    this.dynMode = mode;

    this.minReflectGapTurns  = Math.max(1, Math.floor(args.minReflectGapTurns ?? 3));
    this.reflectWindowMaxMsgs = Math.max(6, Math.floor(args.reflectWindowMaxMsgs ?? 16));
    this.personaTokenFraction = Math.min(0.25, Math.max(0.06, Number(args.personaTokenFraction ?? 0.12)));
    this.personaMaxLines      = Math.max(5, Math.floor(args.personaMaxLines ?? 12));
    this.decayPerPass         = Math.min(0.15, Math.max(0.0, Number(args.decayPerPass ?? 0.03)));
    this.minKeepWeight        = Math.min(0.50, Math.max(0.05, Number(args.minKeepWeight ?? 0.22)));
    this.mergeAggressiveness  = Math.min(1.0, Math.max(0.1, Number(args.mergeAggressiveness ?? 0.60)));

    this.store = new MemoryPersisitence<PersistedState>({ filePath: path.join(R.cwd(), ".orgmemories"), pretty: true });
  }

  //must be idempotent
  async load() {
    const prior = await this.store.load(); // PersistedState | null
    if (prior) {
      this.persona = prior?.persona as PersonaModel ?? {}; //FIXME - types
      this.ledger = prior?.ledger as PersonaEvent ?? {};
      this.messagesBuffer = prior?.messagesBuffer ?? [];
    }
  }

  async save() {
    await this.store.save({ version: this.persona.version, persona: this.persona, ledger: this.ledger, messagesBuffer: this.messagesBuffer });
  }

  // ---------------------------------------------------------------------------
  // Main hook
  // ---------------------------------------------------------------------------

  protected async onAfterAdd(): Promise<void> {
    this.turnCounter++;

    // Reflection by cadence (language-agnostic; single LLM call).
    if (this.dynMode !== "off" && this.turnCounter - this.lastReflectTurn >= this.minReflectGapTurns) {
      // Non-blocking; serialized by AgentMemory.runOnce
      void this.runOnce(async () => {
        await this.reflectAndSquashPersona();
      });
    }

    // Original summarization flow when context is high
    const budget = this.budgetTokens();
    const estTok = this.estimateTokens(this.messagesBuffer);
    if (estTok <= Math.floor(this.highRatio * budget)) return;

    await this.runOnce(async () => {
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

      const preserved: ChatMessage[] = [
        ...sysHead, ...keepAssistant, ...keepSystem, ...keepUser, ...keepTools, ...other
      ];
      const preservedTok = this.estimateTokens(preserved);

      const lowTarget = Math.floor(this.lowRatio * budget2);
      const maxSummaryTok = Math.floor(this.summaryRatio * budget2);

      if (preservedTok <= lowTarget) {
        const rebuilt = this.ordered([], sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);
        return;
      }

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
      if (sumA) summaries.push({ from:"Me",     role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
      if (sumS) summaries.push({ from:"System", role: "system",    content: `SYSTEM SUMMARY:\n${sumS}` });
      if (sumU) summaries.push({ from:"Memory", role: "user",      content: `USER SUMMARY:\n${sumU}` });

      const rebuilt = this.ordered(summaries, sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

      // Clamp to budget (drop oldest non-system)
      let finalTok = this.estimateTokens(this.messagesBuffer);
      if (finalTok > lowTarget) {
        const pruned: ChatMessage[] = [];
        for (const m of this.messagesBuffer) {
          pruned.push(m);
          finalTok = this.estimateTokens(pruned);
          if (finalTok > lowTarget && m.role !== "system") pruned.pop();
        }
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...pruned);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Reflective Persona (v2)
  // ---------------------------------------------------------------------------

  private async reflectAndSquashPersona(): Promise<void> {
    this.lastReflectTurn = this.turnCounter;

    if (this.dynMode === "off") return;

    const window = this.collectWindow(this.reflectWindowMaxMsgs);
    if (window.length === 0) return;

    // Single LLM call that infers persona deltas in ANY language.
    const update = await this.minePersona(window, Math.floor(this.budgetTokens() * 0.10 * this.avgCharsPerToken));
    if (!update) return;

    // Merge + decay (language-agnostic, not rule-based).
    const accepted = this.mergePersona(update);
    if (!accepted) return;

    if (this.dynMode === "shadow") return;

    const block = this.renderPersonaBlock(); // bounded tokens/lines
    this.embedPersonaBlockIntoSystemHead(block);
  }

  /** Gather a small chronological slice from recent messages across roles. */
  private collectWindow(maxTotal: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = this.messagesBuffer.length - 1; i >= 0 && out.length < maxTotal; i--) {
      out.push(this.messagesBuffer[i]);
    }
    return out.reverse();
  }

  /**
   * Asks the model to infer persona facets (roles, style, heuristics, anti-goals, languages)
   * and a friction score. Output must be strict JSON.
   */
  private async minePersona(window: ChatMessage[], approxChars: number): Promise<PersonaUpdate | null> {
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
        "You are a reflective meta-cognition module for an AI assistant.",
        "Given a mixed-language transcript (user/assistant/tool), infer durable persona facets that",
        "would have improved prior replies prospectively (roles, tone/style, planning heuristics, anti-goals, language).",
        "Avoid prescriptive hard policies; prefer succinct, human-like self-modeling.",
        "Never propose anything that enables network/git, weakens sandbox/review, or violates safety.",
        "Output STRICT JSON only—no prose."
      ].join(" ")
    };

    const schema = [
      "{",
      `  "friction": 0.0,             // 0..1 alignment friction`,
      `  "confidence": 0.0,          // 0..1 confidence in this update`,
      `  "persona": {`,
      `    "roles":      [{"text": "...", "weight": 0.0}],`,
      `    "style":      [{"text": "...", "weight": 0.0}],`,
      `    "heuristics": [{"text": "...", "weight": 0.0}],`,
      `    "antigoals":  [{"text": "...", "weight": 0.0}],`,
      `    "languages":  [{"text": "...", "weight": 0.0}]`,
      `  }`,
      "}"
    ].join("\n");

    const usr: ChatMessage = {
      role: "user",
      from: "User",
      content: [
        "Distill a PERSONA UPDATE from the transcript below. Use ANY language found in the transcript.",
        "Keep items short (<= 80 chars each). Weights are in [0,1].",
        "SCHEMA:",
        schema,
        "TRANSCRIPT:",
        acc
      ].join("\n\n")
    };

    const out = await this.driver.chat([sys, usr], { model: this.model });
    const text = this.extractText(out);
    const obj = this.safeParseJson(text);
    if (!obj || typeof obj !== "object") return null;

    // Validate & clamp
    try {
      const p = (obj as any).persona ?? {};
      const norm = (arr: any): PersonaFacet[] =>
        Array.isArray(arr)
          ? arr.slice(0, 12).map((x: any) => ({
              text: String(x?.text ?? "").trim(),
              weight: this.clamp01(Number(x?.weight ?? 0))
            })).filter((x: PersonaFacet) => x.text.length > 0 && x.text.length <= 80)
          : [];

      const upd: PersonaUpdate = {
        friction: this.clamp01(Number((obj as any).friction ?? 0)),
        confidence: this.clamp01(Number((obj as any).confidence ?? 0)),
        persona: {
          roles: norm(p.roles),
          style: norm(p.style),
          heuristics: norm(p.heuristics),
          antigoals: norm(p.antigoals),
          languages: norm(p.languages)
        }
      };
      return upd;
    } catch {
      return null;
    }
  }

  /** Merge update into persona with decay & bounded capacity (no hard rules). */
  private mergePersona(update: PersonaUpdate): boolean {
    // Decay
    const decay = 1 - this.decayPerPass;
    const aged = (xs: PersonaFacet[]) =>
      xs.map(f => ({ ...f, weight: f.weight * decay }));

    const now = this.turnCounter;
    this.persona.roles      = aged(this.persona.roles);
    this.persona.style      = aged(this.persona.style);
    this.persona.heuristics = aged(this.persona.heuristics);
    this.persona.antigoals  = aged(this.persona.antigoals);
    this.persona.languages  = aged(this.persona.languages);

    // Merge (language-agnostic; string-equality after normalization)
    const mergeArr = (dst: PersonaFacet[], inc: PersonaFacet[], cap: number) => {
      for (const it of inc) {
        const key = this.normKey(it.text);
        const idx = dst.findIndex(d => this.normKey(d.text) === key);
        const bump = it.weight * this.mergeAggressiveness;
        if (idx >= 0) {
          // 1 - (1 - old) * (1 - bump)
          const w = 1 - (1 - dst[idx].weight) * (1 - bump);
          dst[idx].weight = this.clamp01(w);
        } else {
          dst.push({ text: it.text, weight: this.clamp01(0.5 * bump + 0.15) });
        }
      }
      // Drop very weak; keep strongest first
      const filtered = dst.filter(d => d.weight >= this.minKeepWeight);
      filtered.sort((a, b) => b.weight - a.weight);
      return filtered.slice(0, cap);
    };

    const caps = {
      roles: 3,
      style: 6,
      heuristics: 8,
      antigoals: 6,
      languages: 2
    };

    const before = JSON.stringify(this.persona);
    this.persona.roles      = mergeArr(this.persona.roles,      update.persona.roles,      caps.roles);
    this.persona.style      = mergeArr(this.persona.style,      update.persona.style,      caps.style);
    this.persona.heuristics = mergeArr(this.persona.heuristics, update.persona.heuristics, caps.heuristics);
    this.persona.antigoals  = mergeArr(this.persona.antigoals,  update.persona.antigoals,  caps.antigoals);
    this.persona.languages  = mergeArr(this.persona.languages,  update.persona.languages,  caps.languages);

    const after = JSON.stringify(this.persona);
    if (before !== after) {
      this.persona.version += 1;
      this.persona.lastUpdatedTurn = now;
      this.ledger.push({ type: "merge", at: now, friction: update.friction, confidence: update.confidence });
      return true;
    }
    return false;
  }

  /** Render bounded persona text; prepend guard lines asserting non-override of safety. */
  private renderPersonaBlock(): string {
    const usableTok = this.budgetTokens();
    const personaTok = Math.max(64, Math.floor(usableTok * this.personaTokenFraction));
    const charBudget = Math.max(480, Math.floor(personaTok * this.avgCharsPerToken));
    const maxLines = this.personaMaxLines;

    const header =
      `DYNAMIC PERSONA BLOCK v${this.persona.version}\n` +
      `- Self-model distilled from recent dialogue (language-agnostic).\n` +
      `- Does NOT override static policy, SAFE_MODE, tool caps, or review; it only guides tone/role/heuristics.\n`;

    const sect = (title: string, items: PersonaFacet[]) => {
      const xs = items.slice(0, 99).map(x => x.text);
      return xs.length ? `• ${title}: ${xs.join("; ")}\n` : "";
    };

    let body = "";
    let lines = 0;

    const chunks = [
      sect("Roles & POV", this.persona.roles),
      sect("Style & Rhythm", this.persona.style),
      sect("Decision Heuristics", this.persona.heuristics),
      sect("Soft Anti-goals", this.persona.antigoals),
      sect("Languages", this.persona.languages)
    ].filter(Boolean);

    for (const ch of chunks) {
      if ((header.length + body.length + ch.length) > charBudget) break;
      body += ch;
      lines += (ch.match(/\n/g)?.length ?? 0);
      if (lines >= maxLines) break;
    }

    return header + body;
  }

  /** Append or refresh the persona block within the first system message. */
  private embedPersonaBlockIntoSystemHead(block: string): void {
    const idx = this.messagesBuffer.findIndex(m => m.role === "system");
    if (idx < 0) return;

    const head = this.messagesBuffer[idx];
    const orig = this.messageContent(head);

    const startTag = "\n[BEGIN DYNAMIC PERSONA BLOCK]\n";
    const endTag   = "\n[END DYNAMIC PERSONA BLOCK]\n";
    const payload  = `${startTag}${block}${endTag}`;

    const s = orig.indexOf(startTag);
    const e = orig.indexOf(endTag);
    let next: string;

    if (s >= 0 && e > s) {
      next = orig.slice(0, s) + payload + orig.slice(e + endTag.length);
    } else {
      const sep = orig.endsWith("\n") ? "" : "\n";
      next = `${orig}${sep}${payload}`;
    }

    (head as unknown as { content: string }).content = next;
    this.messagesBuffer[idx] = head;
  }

  // ---------------------------------------------------------------------------
  // Original summarization helpers
  // ---------------------------------------------------------------------------

  private budgetTokens(): number {
    return Math.max(512, this.contextTokens - this.reserveHeaderTokens - this.reserveResponseTokens);
  }

  private estimateTokens(msgs: ChatMessage[]): number {
    return Math.ceil(this.totalChars(msgs) / this.avgCharsPerToken);
  }

  private totalChars(msgs: ChatMessage[]): number {
    let c = 0;
    for (const m of msgs) {
      const s = this.messageContent(m);
      if (m.role === "tool" && s.length > 24_000) c += 24_000; else c += s.length;
      c += 32;
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
    for (const m of this.messagesBuffer) if (keepSet.has(m)) rest.push(m);

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

    let acc = "";
    for (const m of messages) {
      let c = this.messageContent(m);
      if (c.length > 4000) c = c.slice(0, 4000) + "\n…(truncated)…";
      const next = `- ${laneName.toUpperCase()}: ${c}\n\n`;
      if (acc.length + next.length > approxChars * 3) break;
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

  // ------------------------------- Utilities ---------------------------------

  private extractText(out: unknown): string {
    if (typeof out === "string") return out;
    if (out && typeof out === "object" && "text" in (out as Record<string, unknown>)) {
      const v = (out as Record<string, unknown>).text;
      if (typeof v === "string") return v;
    }
    return "";
  }

  private safeParseJson(text: string): unknown {
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) return JSON.parse(trimmed);
      const m = text.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }

  private clamp01(x: number): number {
    if (Number.isNaN(x)) return 0;
    return Math.max(0, Math.min(1, x));
  }

  private normKey(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

/* --------------------------------- Types ---------------------------------- */

type PersonaFacet = { text: string; weight: number };

type PersonaModel = {
  version: number;
  lastUpdatedTurn: number;
  roles: PersonaFacet[];
  style: PersonaFacet[];
  heuristics: PersonaFacet[];
  antigoals: PersonaFacet[];
  languages: PersonaFacet[];
};

type PersonaUpdate = {
  friction: number;    // 0..1
  confidence: number;  // 0..1
  persona: {
    roles: PersonaFacet[];
    style: PersonaFacet[];
    heuristics: PersonaFacet[];
    antigoals: PersonaFacet[];
    languages: PersonaFacet[];
  };
};

type PersonaEvent = {
  type: "merge";
  at: number;
  friction: number;
  confidence: number;
};
