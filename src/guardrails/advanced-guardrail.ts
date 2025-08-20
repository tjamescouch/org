import { GuardDecision, GuardRail, GuardRouteKind, Reason } from "./guardrail";

export class AdvancedGuardRail implements GuardRail {
  /**
   * A "cutting‑edge" guard rail with multi-signal stagnation detection,
   * dynamic thresholds, richer nudges, and proactive fallbacks.
   *
   * Highlights vs StandardGuardRail
   * - Multi-metric similarity (token Jaccard + 3‑gram overlap) for loop detection
   * - Detects “no-progress” tool loops: identical args + unchanged results
   * - Tracks failure ratio of tools; escalates with adaptive end-turn
   * - Suggests concrete alternatives (ask user, DM a peer, different tool plan)
   * - Detects patch-DSL / apply_patch misuse and nudges to use ##file / sh
   * - Idle fallback crafts targeted prompt that includes peer suggestions
   */

  private readonly agentId: string;
  private readonly overrideMissingArgEndTurnLimit?: number;
  private readonly overrideRepeatToolSigEndTurnLimit?: number;

  // ---------------- configurable knobs --------------------------------------
  private readonly nearDupThreshold = 0.82;         // token‑level
  private readonly triGramOverlapThreshold = 0.68;  // character 3‑gram overlap
  private readonly stagnationWindow = 5;            // last N group messages to compare against
  private readonly defaultMuteMs = 1200;

  // End-turn caps (computed per turn in beginTurn)
  private badToolEndTurnLimit = 2;
  private repeatToolSigEndTurnLimit = 2;

  // ---------------- rolling state (cross-turn) -------------------------------
  private recentGroupNorms: string[] = [];       // ring buffer of normalized @@group messages
  private consecutiveNoToolCalls = 0;

  // ---------------- per-turn state (reset in beginTurn) ----------------------
  private assistantTurnsThisRound = 0;

  private badToolMissingArgCount = 0;
  private toolSigCounts: Map<string, number> = new Map();

  // Per tool-signature: last result sig, repeats of "no progress", and fail streaks
  private lastResultBySig: Map<string, string> = new Map();
  private noChangeCountBySig: Map<string, number> = new Map();
  private failStreakBySig: Map<string, number> = new Map();

  constructor(args: {
    agentId: string;
    missingArgEndTurnLimit?: number;
    repeatToolSigEndTurnLimit?: number;
  }) {
    this.agentId = args.agentId;
    this.overrideMissingArgEndTurnLimit = args.missingArgEndTurnLimit;
    this.overrideRepeatToolSigEndTurnLimit = args.repeatToolSigEndTurnLimit;
  }

  // --------------------------------------------------------------------------
  // lifecycle
  // --------------------------------------------------------------------------
  beginTurn(ctx: { maxToolHops: number }): void {
    // Reset per-turn counters
    this.assistantTurnsThisRound = 0;
    this.badToolMissingArgCount = 0;
    this.toolSigCounts.clear();
    this.noChangeCountBySig.clear();
    this.failStreakBySig.clear();

    // Adaptive limits: allow slightly more exploration if hop budget is large.
    const hop = Math.max(0, Math.floor(ctx.maxToolHops));
    const adaptiveMissing = Math.min(
      4,                              // hard cap
      Math.max(1, Math.ceil(hop / 2)) // 0->1, 1->1, 2->1, 3->2, 4->2, 5->3, ...
    );
    this.badToolEndTurnLimit =
      this.overrideMissingArgEndTurnLimit ?? adaptiveMissing;

    const adaptiveRepeat = Math.min(4, Math.max(2, Math.ceil(hop / 2)));
    this.repeatToolSigEndTurnLimit =
      this.overrideRepeatToolSigEndTurnLimit ?? adaptiveRepeat;
  }

  noteAssistantTurn(info: { text: string; toolCalls: number }): void {
    this.assistantTurnsThisRound++;
    if (info.toolCalls > 0) this.consecutiveNoToolCalls = 0;
    else this.consecutiveNoToolCalls++;
  }

  // --------------------------------------------------------------------------
  // tool safety / stagnation
  // --------------------------------------------------------------------------
  noteBadToolCall(info: {
    name: string;
    reason: Reason;
    missingArgs?: string[];
  }): GuardDecision | null {
    if (info.reason === "missing-arg") {
      this.badToolMissingArgCount++;
      const remaining = Math.max(0, this.badToolEndTurnLimit - this.badToolMissingArgCount);
      const severity = remaining <= 0 ? "FINAL" : remaining === 1 ? "STRONG" : "WARNING";
      const missing = (info.missingArgs ?? []).join(", ") || "required argument(s)";
      const guidance = this.exampleForTool(info.name);

      const nudge =
`SYSTEM ${severity} WARNING:
You attempted to call "${info.name}" without ${missing}.
Fix the arguments and try once more.

Usage hint:
${guidance}`;

      if (remaining <= 0) {
        return {
          nudge:
`${nudge}

Ending your turn now. Next turn: either
- @@user Ask a single, concrete question, or
- @@peer Delegate a well-scoped subtask.`,
          endTurn: true,
          muteMs: this.defaultMuteMs,
          warnings: ["missing-arg-retry-limit-reached"]
        };
      }
      return { nudge, warnings: ["missing-arg"] };
    }
    return null;
  }

  noteToolCall(info: {
    name: string;
    argsSig: string;
    resSig?: string;
    exitCode?: number;
  }): GuardDecision | null {
    const sig = `${info.name}|${this.normalize(info.argsSig)}`;

    // 1) Repetition of the *same* tool + args within THIS turn.
    const repeats = (this.toolSigCounts.get(sig) ?? 0) + 1;
    this.toolSigCounts.set(sig, repeats);

    // 2) Track unchanged results for the same signature.
    const prevRes = this.lastResultBySig.get(sig);
    const thisRes = `${info.exitCode ?? ""}|${(info.resSig ?? "").slice(0, 256)}`;
    this.lastResultBySig.set(sig, thisRes);

    const unchanged = prevRes !== undefined && prevRes === thisRes;
    const noChange = (this.noChangeCountBySig.get(sig) ?? 0) + (unchanged ? 1 : 0);
    this.noChangeCountBySig.set(sig, noChange);

    // 3) Failure streaks (non-zero exit codes)
    const failStreak = (this.failStreakBySig.get(sig) ?? 0);
    const nextFailStreak = (info.exitCode && info.exitCode !== 0) ? failStreak + 1 : 0;
    this.failStreakBySig.set(sig, nextFailStreak);

    // Decisions (most severe first)
    if (repeats >= this.repeatToolSigEndTurnLimit) {
      const nudge =
`SYSTEM FINAL WARNING:
You are repeating "${info.name}" with identical arguments:
  args: ${info.argsSig}
Stop retrying the same command. Either:
- Change the command/arguments,
- Run a different diagnostic, or
- @@user Ask for a clarifying input.`;
      return { nudge, endTurn: true, muteMs: this.defaultMuteMs, warnings: ["repeat-tool-args"] };
    }

    if (noChange >= 2) {
      const nudge =
`SYSTEM:
The last ${noChange + 1} "${info.name}" runs produced the *same* result for the *same* arguments:
  args: ${info.argsSig}
This indicates a no‑progress loop. Switch strategy now:
- Try a different command or alter parameters
- Or @@user request guidance to unblock.`;
      return { nudge, endTurn: true, muteMs: this.defaultMuteMs, warnings: ["no-progress-tool-loop"] };
    }

    if (nextFailStreak >= 2) {
      const nudge =
`SYSTEM:
Two consecutive failures from "${info.name}" for:
  args: ${info.argsSig}
Do NOT keep retrying blindly. Consider:
- Inspecting error output and choosing a different command,
- Or asking @@user for missing preconditions (paths, permissions, credentials).`;
      return { nudge, warnings: ["consecutive-tool-failures"] };
    }

    // Mild nudge for an early repeat (not yet at limit)
    if (repeats === 2) {
      const nudge =
`SYSTEM WARNING:
You're repeating "${info.name}" with the same arguments.
Avoid redundant calls; change inputs or pivot strategy.`;
      return { nudge, warnings: ["early-repeat"] };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // routing / broadcast hygiene
  // --------------------------------------------------------------------------
  guardCheck(route: GuardRouteKind, content: string, peers: string[]): GuardDecision | null {
    const warnings: string[] = [];
    const norm = this.normalize(content);

    // Common hygiene
    const hasExplicitTag = /@{2}(user|group|[A-Za-z0-9._-]+)/.test(content);
    if (!hasExplicitTag) warnings.push("no-explicit-tag");
    if (this.consecutiveNoToolCalls >= 2) warnings.push("several-turns-without-tools");

    // Detect misuse of apply_patch / DSLs (frequent escape hatch bugs)
    if (/apply_patch\s*<</i.test(content) || /<<<\s*PATCH/i.test(content)) {
      const nudge =
`SYSTEM:
Do not use "apply_patch <<PATCH". To write files, emit a literal file block:

##file:path/to/file.ext
<content here>

To run shell commands, call the "sh" tool with: {"cmd":"<command>"} .`;
      return { nudge, suppressBroadcast: true, muteMs: this.defaultMuteMs, warnings: ["patch-dsl-misuse"] };
    }

    // Group broadcast: detect low-signal near-duplicates across a sliding window.
    if (route === "group") {
      const lowSignal = this.isLowSignal(content);
      const nearDup = this.isNearDuplicateOfRecent(norm);

      // Heavier suppression if: low-signal AND near-duplicate AND agent has not made tool progress.
      if (lowSignal && nearDup) {
        const suggest = this.suggestHandoff(peers);
        const nudge =
`SYSTEM:
Your last few @@group messages are low‑signal and very similar.
Switch tactics on your next turn:
- @@user Ask one concrete question to move work forward${suggest ? `, or\n- @@${suggest} DM a well‑scoped subtask` : ""}.`;
        // Remember for future comparisons, but suppress broadcast now.
        this.rememberGroup(norm);
        return { nudge, suppressBroadcast: true, muteMs: this.defaultMuteMs, warnings: ["stagnant-group-broadcast"] };
      }

      // Light nudge if low-signal OR repeated with slight variation
      if (lowSignal || nearDup) {
        const nudge =
`SYSTEM WARNING:
Your message adds little new information. Prefer a specific ask or a concrete next step.`;
        this.rememberGroup(norm);
        return { nudge, warnings: ["weak-signal-group"] };
      }

      this.rememberGroup(norm);
    }

    return warnings.length ? { warnings } : null;
  }

  // --------------------------------------------------------------------------
  // idle fallback
  // --------------------------------------------------------------------------
  onIdle?(state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }): GuardDecision | null {
    if (!state.queuesEmpty) return null;
    if (state.idleTicks < 3) return null;

    const peerLine = state.peers.length
      ? `- "@@${state.peers[0]}" Ask that agent to run a specific command and report back.`
      : `- "@@user" Direct a specific agent with a command.`;

    const prompt =
`(scheduler)
All agents are idle — no queued work and no actionable outputs.
Please provide the next *concrete* instruction.

Examples:
- "@@user Outline the next milestone and first task."
${peerLine}
- "Switch context to <topic> and set a single success criterion."`;

    return { askUser: prompt, warnings: ["scheduler-idle-advanced"] };
  }

  // --------------------------------------------------------------------------
  // helpers
  // --------------------------------------------------------------------------
  private suggestHandoff(peers: string[]): string | null {
    // Pick any peer that's not this agent; deterministic order
    const candidate = peers.find(p => p !== this.agentId);
    return candidate ?? null;
  }

  private rememberGroup(norm: string) {
    if (!norm) return;
    this.recentGroupNorms.push(norm);
    if (this.recentGroupNorms.length > this.stagnationWindow) {
      this.recentGroupNorms.shift();
    }
  }

  private isNearDuplicateOfRecent(norm: string): boolean {
    if (!norm) return false;
    let maxTok = 0;
    let maxTri = 0;

    for (const prev of this.recentGroupNorms) {
      maxTok = Math.max(maxTok, this.jaccardTokens(prev, norm));
      maxTri = Math.max(maxTri, this.trigramOverlap(prev, norm));
    }
    // Require both signals to be high to call it a near‑duplicate.
    return maxTok >= this.nearDupThreshold && maxTri >= this.triGramOverlapThreshold;
  }

  private normalize(s: string): string {
    return String(s || "")
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, " ") // strip code fences to their gist
      .replace(/[`*_~>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private tokenize(s: string): string[] {
    return this.normalize(s)
      .split(" ")
      .filter(Boolean);
  }

  private jaccardTokens(a: string, b: string): number {
    const A = new Set(this.tokenize(a));
    const B = new Set(this.tokenize(b));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / new Set([...A, ...B]).size;
    }

  private trigramOverlap(a: string, b: string): number {
    const A = this.trigrams(a);
    const B = this.trigrams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return inter / Math.min(A.size, B.size); // scaled overlap
  }

  private trigrams(s: string): Set<string> {
    const t = this.normalize(s).replace(/\s+/g, " ");
    const set = new Set<string>();
    for (let i = 0; i + 2 < t.length; i++) {
      set.add(t.slice(i, i + 3));
    }
    return set;
  }

  private isLowSignal(text: string): boolean {
    const s = this.normalize(text);
    if (s.length < 12) return true;
    const pats = [
      /what can i help/i,
      /how can i help/i,
      /what would you like/i,
      /i'?m here.*ready to help/i,
      /let me know/i,
      /sounds good.*just let me know/i,
      /following up/i,
      /checking in/i
    ];
    // Very short messages or ones matching boilerplate are low-signal.
    if (pats.some(re => re.test(text))) return true;
    const wordCount = s.split(" ").length;
    return wordCount <= 8;
  }

  private exampleForTool(name: string): string {
    if (name === "sh") {
      return `{"cmd":"ls -la"}  (example)
Return JSON: {"ok":boolean,"stdout":string,"stderr":string,"exit_code":number,"cmd":string}`;
    }
    return `${name}(<args...>)`;
  }
}
