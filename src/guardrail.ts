// src/guardrail.ts
import { Logger } from "./logger";

export type GuardRouteKind = "group" | "agent" | "user" | "file";

export type GuardDecision = {
  /** Add a message to the agent's inbox (as system guidance) */
  nudge?: string | null;
  /** Do not broadcast the current message to its original audience */
  suppressBroadcast?: boolean;
  /** Temporarily mute the agent so others can progress */
  muteMs?: number;
  /** Free-form warnings for observability / logs */
  warnings?: string[];
};

export interface GuardRail {
  /** Record facts about the agent's last assistant turn (for trends). */
  noteAssistantTurn(info: { text: string; toolCalls: number }): void;

  /** Evaluate an outgoing routed delivery from the agent. */
  guardCheck(route: GuardRouteKind, content: string, peers: string[]): GuardDecision | null;
}

/**
 * StandardGuardRail:
 *  - Detects near-duplicate / low-signal repeated @@group messages.
 *  - Encourages switching to @@user or a direct @@peer when stuck.
 *  - Emits warnings (observability) and recommends scheduler actions.
 */
export class StandardGuardRail implements GuardRail {
  private readonly agentId: string;

  // repetition tracking
  private lastNorm = "";
  private repeatCount = 0;

  // tool usage trend
  private consecutiveNoToolCalls = 0;

  // thresholds (tunable)
  private readonly nearDupThreshold = 0.80;
  private readonly stagnationRepeatThreshold = 3; // ≥3 near-duplicates
  private readonly lowSignalRepeatThreshold = 2;  // ≥2 repeats if low-signal
  private readonly defaultMuteMs = 1500;

  constructor(args: { agentId: string }) {
    this.agentId = args.agentId;
  }

  noteAssistantTurn(info: { text: string; toolCalls: number }): void {
    if (info.toolCalls > 0) this.consecutiveNoToolCalls = 0;
    else this.consecutiveNoToolCalls++;
    // repetition is updated at guardCheck where we have the routed content
  }

  guardCheck(route: GuardRouteKind, content: string, peers: string[]): GuardDecision | null {
    const warnings: string[] = [];
    const norm = this.normalize(content);

    const nearDup = this.jaccard(this.lastNorm, norm) >= this.nearDupThreshold;
    this.repeatCount = nearDup ? this.repeatCount + 1 : 1;
    this.lastNorm = norm;

    const isLowSignal = this.isLowSignal(content);

    // Generic warnings
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

  // --- helpers -------------------------------------------------------------

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
