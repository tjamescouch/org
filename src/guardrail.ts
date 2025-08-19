// src/guardrail.ts
import { Logger } from "./logger";

export type GuardRouteKind = "group" | "agent" | "user" | "file";

export type GuardDecision = {
  /** Add a message to the agent's context (as system guidance). */
  nudge?: string | null;
  /** Do not broadcast the current message to its original audience. */
  suppressBroadcast?: boolean;
  /** Temporarily mute the agent so others can progress (used by scheduler). */
  muteMs?: number;
  /** Free-form warnings for observability / logs. */
  warnings?: string[];
  /** Forcibly end the current agent turn (stop further tool hops this turn). */
  endTurn?: boolean;
};

export interface GuardRail {
  /**
   * Called once at the beginning of each agent "turn" (i.e., per respond() call).
   * Used to (re)initialize per-turn counters and thresholds.
   */
  beginTurn(ctx: { maxToolHops: number }): void;

  /** Record facts about the agent's last assistant completion. */
  noteAssistantTurn(info: { text: string; toolCalls: number }): void;

  /**
   * Notify guard rail of a problematic tool call (e.g., missing arguments).
   * Return an optional decision that may include a nudge and/or endTurn=true.
   */
  noteBadToolCall(info: {
    name: string;
    /** Human/enum code like "missing-arg", "missing-args", etc. */
    reason: string;
    /** If reason === missing-arg(s), specify which argument names are missing. */
    missingArgs?: string[];
  }): GuardDecision | null;

  /**
   * Notify guard rail of a (successful) tool call to detect repeats within a turn.
   * argsSig should uniquely represent the arguments relevant to the call (e.g., sh cmd).
   * resSig can summarize notable result surface (e.g., stdout snippet + exit code).
   */
  noteToolCall(info: {
    name: string;
    argsSig: string;
    resSig?: string;
    exitCode?: number;
  }): GuardDecision | null;

  /**
   * Evaluate an outgoing routed delivery from the agent (e.g., @@group).
   * Used by the scheduler to decide broadcast suppression and nudges.
   */
  guardCheck(route: GuardRouteKind, content: string, peers: string[]): GuardDecision | null;
}

/**
 * StandardGuardRail:
 *  - Detects near-duplicate / low-signal repeated @@group messages.
 *  - Encourages switching to @@user or direct @@peer when stuck.
 *  - Tracks repeated invalid tool calls (e.g., sh missing "cmd"), escalates warnings,
 *    and can force end-turn when the limit is reached.
 *  - Tracks repeated *identical tool calls* in the same turn; escalates and can end turn.
 */
export class StandardGuardRail implements GuardRail {
  private readonly agentId: string;

  // --- config knobs ----------------------------------------------------------
  /** Optional override for invalid-tool end-turn limit (per turn). */
  private readonly overrideMissingArgEndTurnLimit?: number;
  /** Optional override for repeated tool signature end-turn limit (per turn). */
  private readonly overrideRepeatToolSigEndTurnLimit?: number;

  /** Similarity threshold for considering two messages near-duplicates. */
  private readonly nearDupThreshold = 0.80;
  /** Repeats needed to flag repeated near-duplicate @@group messages. */
  private readonly stagnationRepeatThreshold = 3;
  /** Repeats needed if the message is low-signal. */
  private readonly lowSignalRepeatThreshold = 2;
  /** Suggested temporary mute for repeated low-signal group chatter (ms). */
  private readonly defaultMuteMs = 1500;

  // --- state: group loop detection ------------------------------------------
  private lastNorm = "";
  private repeatCount = 0;

  // Track tool usage trends across completions.
  private consecutiveNoToolCalls = 0;

  // --- state: invalid tool calls (per turn) ---------------------------------
  private badToolMissingArgCount = 0;
  private badToolEndTurnLimit = 1; // computed each beginTurn

  // --- state: repeated tool signatures (per turn) ----------------------------
  private toolSigCounts: Map<string, number> = new Map();
  private repeatToolSigEndTurnLimit = 2; // computed each beginTurn

  constructor(args: {
    agentId: string;
    missingArgEndTurnLimit?: number;
    repeatToolSigEndTurnLimit?: number;
  }) {
    this.agentId = args.agentId;
    this.overrideMissingArgEndTurnLimit = args.missingArgEndTurnLimit;
    this.overrideRepeatToolSigEndTurnLimit = args.repeatToolSigEndTurnLimit;
  }

  beginTurn(ctx: { maxToolHops: number }): void {
    // Reset per-turn counters.
    this.badToolMissingArgCount = 0;
    this.toolSigCounts.clear();

    // Compute limits for this turn.
    const defaultHalf = Math.max(1, Math.ceil(Math.max(0, ctx.maxToolHops) / 2));
    this.badToolEndTurnLimit = Math.max(
      1,
      this.overrideMissingArgEndTurnLimit ?? defaultHalf
    );
    // Allow one repeat then end (default 2); or align with the same half rule if overridden.
    this.repeatToolSigEndTurnLimit = Math.max(
      2, // minimum sensible value (first time + one repeat)
      this.overrideRepeatToolSigEndTurnLimit ?? 2
    );
  }

  noteAssistantTurn(info: { text: string; toolCalls: number }): void {
    if (info.toolCalls > 0) this.consecutiveNoToolCalls = 0;
    else this.consecutiveNoToolCalls++;
  }

  noteBadToolCall(info: {
    name: string;
    reason: string;
    missingArgs?: string[];
  }): GuardDecision | null {
    const warnings: string[] = [];

    if (info.reason === "missing-arg" || info.reason === "missing-args") {
      this.badToolMissingArgCount++;
      const count = this.badToolMissingArgCount;
      const limit = this.badToolEndTurnLimit;
      const need =
        info.missingArgs && info.missingArgs.length
          ? `"${info.missingArgs.join('", "')}"`
          : "required arguments";

      // Escalating message tone
      let label = "WARNING";
      if (count >= Math.max(2, limit - 1)) label = "FINAL WARNING";
      else if (count >= 2) label = "STRONG WARNING";

      if (count >= limit) {
        const nudge =
`SYSTEM ${label}:
Repeated invalid "${info.name}" tool calls (missing ${need}). Ending your turn now.
On your next turn, use @@user to ask for clarification OR DM a peer with a concrete request (e.g., @@alice <task>).`;
        return { nudge, endTurn: true, warnings };
      }

      const nudge =
`SYSTEM ${label}:
You invoked the "${info.name}" tool without ${need}.
Provide valid arguments next hop (e.g., {"cmd":"<non-empty command>"}).
${count >= Math.max(2, limit - 1) ? "One more invalid tool call will END your turn." : "Fix this before calling tools again."}`;
      return { nudge, warnings };
    }

    return warnings.length ? { warnings } : null;
  }

  noteToolCall(info: {
    name: string;
    argsSig: string;
    resSig?: string;
    exitCode?: number;
  }): GuardDecision | null {
    const warnings: string[] = [];

    // Signature = tool + normalized args; result signature optional.
    const key = `${info.name}|${this.normalize(info.argsSig)}`;
    const count = (this.toolSigCounts.get(key) ?? 0) + 1;
    this.toolSigCounts.set(key, count);

    if (count === 1) return null; // first time: fine

    // Escalate on repeats within the *same turn*.
    const limit = this.repeatToolSigEndTurnLimit;
    let label = "WARNING";
    if (count >= Math.max(2, limit - 1)) label = "FINAL WARNING";
    else if (count >= 2) label = "STRONG WARNING";

    const base =
`SYSTEM ${label}:
You are repeating the same "${info.name}" call this turn:
  args: ${info.argsSig}
${info.resSig ? `  last result: ${truncate(info.resSig, 160)}` : ""}`;

    if (count >= limit) {
      const nudge =
`${base}
Ending your turn now. On your next turn, switch strategies:
- @@user <ask a single, concrete question>, or
- @@peer <delegate a specific subtask>.`;
      return { nudge, endTurn: true, warnings };
    }

    const nudge =
`${base}
Do not re-run the same command again. Either change the arguments, run a DIFFERENT diagnostic, or DM a peer.`;
    return { nudge, warnings };
  }

  guardCheck(route: GuardRouteKind, content: string, peers: string[]): GuardDecision | null {
    const warnings: string[] = [];
    const norm = this.normalize(content);
    const nearDup = this.jaccard(this.lastNorm, norm) >= this.nearDupThreshold;
    this.repeatCount = nearDup ? this.repeatCount + 1 : 1;
    this.lastNorm = norm;

    const isLowSignal = this.isLowSignal(content);

    if (isLowSignal) warnings.push("low-signal message");
    if (!/@{2}(user|group|[A-Za-z0-9._-]+)/.test(content)) {
      warnings.push("no explicit @@tag detected");
    }
    if (this.consecutiveNoToolCalls >= 2) {
      warnings.push("multiple assistant turns without tool calls");
    }

    if (route === "group") {
      const stuckByRepeat = nearDup && this.repeatCount >= this.stagnationRepeatThreshold;
      const stuckByLowSignal = isLowSignal && this.repeatCount >= this.lowSignalRepeatThreshold;

      if (stuckByRepeat || stuckByLowSignal) {
        const peersList = peers.filter(p => p !== this.agentId).map(p => `@@${p}`).join(" or ");
        const nudge =
`SYSTEM NOTE:
You are repeating low-signal @@group messages. On your next turn do ONE of:
- @@user <ask a single, concrete question>, or
- ${peersList || "@@peer"} <delegate a specific task>.
Do NOT reply to @@group again.`;
        return {
          nudge,
          suppressBroadcast: true,
          muteMs: this.defaultMuteMs,
          warnings
        };
      }
    }

    return warnings.length ? { warnings } : null;
  }

  // --- helpers ---------------------------------------------------------------

  private normalize(s: string): string {
    return String(s || "")
      .toLowerCase()
      .replace(/[`*_~>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private jaccard(a: string, b: string): number {
    if (!a || !b) return 0;
    const A = new Set(a.split(" "));
    const B = new Set(b.split(" "));
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const union = new Set([...A, ...B]).size;
    return union === 0 ? 0 : inter / union;
  }

  private isLowSignal(text: string): boolean {
    const s = this.normalize(text);
    if (s.length < 12) return true;
    if (s.length > 240) return false;
    const pats = [
      /what can i help/i,
      /how can i help/i,
      /what would you like/i,
      /i'?m here.*ready to help/i,
      /let me know/i,
      /sounds good.*just let me know/i,
    ];
    return pats.some((re) => re.test(text)) || s.split(" ").length <= 8;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}
