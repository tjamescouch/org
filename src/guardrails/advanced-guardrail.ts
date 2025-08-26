// src/advanced-guardrail.ts
import { GuardDecision, GuardRail, GuardRouteKind, Reason } from "./guardrail";

/**
 * AdvancedGuardRail
 * - stagnation detection (token Jaccard + trigram overlap)
 * - no‑progress tool loop detection
 * - failure streak nudges
 * - patch DSL misuse detection
 * - low‑signal group broadcast control
 * - (helper) response sanitation/repair happens in sanitizer.ts and is invoked by the agent
 */
export class AdvancedGuardRail implements GuardRail {
  private readonly agentId: string;
  private readonly overrideMissingArgEndTurnLimit?: number;
  private readonly overrideRepeatToolSigEndTurnLimit?: number;

  // ---------------- configurable knobs --------------------------------------
  private readonly nearDupThreshold = 0.82;
  private readonly triGramOverlapThreshold = 0.68;
  private readonly stagnationWindow = 5;
  private readonly defaultMuteMs = 1200;

  // turn‑local caps (adapted in beginTurn)
  private badToolEndTurnLimit = 2;
  private repeatToolSigEndTurnLimit = 2;

  // ---------------- rolling state -------------------------------------------
  private recentGroupNorms: string[] = [];
  private consecutiveNoToolCalls = 0;

  // ---------------- per‑turn state ------------------------------------------
  private assistantTurnsThisRound = 0;

  private badToolMissingArgCount = 0;
  private toolSigCounts: Map<string, number> = new Map();
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

  // lifecycle ---------------------------------------------------------------
  beginTurn(ctx: { maxToolHops: number }): void {
    this.assistantTurnsThisRound = 0;
    this.badToolMissingArgCount = 0;
    this.toolSigCounts.clear();
    this.noChangeCountBySig.clear();
    this.failStreakBySig.clear();

    const hop = Math.max(0, Math.floor(ctx.maxToolHops));
    const adaptiveMissing = Math.min(4, Math.max(1, Math.ceil(hop / 2)));
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

  // tool safety / stagnation ------------------------------------------------
  noteBadToolCall(info: {
    name: string;
    reason: Reason;
    missingArgs?: string[];
  }): GuardDecision | null {
    if (info.reason === "missing-arg") {
      this.badToolMissingArgCount++;
      const remaining = Math.max(
        0,
        this.badToolEndTurnLimit - this.badToolMissingArgCount
      );
      const severity =
        remaining <= 0 ? "FINAL" : remaining === 1 ? "STRONG" : "WARNING";
      const missing =
        (info.missingArgs ?? []).join(", ") || "required argument(s)";
      const guidance = this.exampleForTool(info.name);

      const nudge = `SYSTEM ${severity} WARNING:
You attempted to call "${info.name}" without ${missing}.
Fix the arguments and try once more.

Usage hint:
${guidance}`;

      if (remaining <= 0) {
        return {
          nudge: `${nudge}

Ending your turn now. Next turn: either
- @@user Ask a single, concrete question, or
- @@peer Delegate a well‑scoped subtask.`,
          endTurn: true,
          muteMs: this.defaultMuteMs,
          warnings: ["missing-arg-retry-limit-reached"],
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

    const repeats = (this.toolSigCounts.get(sig) ?? 0) + 1;
    this.toolSigCounts.set(sig, repeats);

    const prevRes = this.lastResultBySig.get(sig);
    const thisRes = `${info.exitCode ?? ""}|${(info.resSig ?? "").slice(
      0,
      256
    )}`;
    this.lastResultBySig.set(sig, thisRes);

    const unchanged = prevRes !== undefined && prevRes === thisRes;
    const noChange = (this.noChangeCountBySig.get(sig) ?? 0) + (unchanged ? 1 : 0);
    this.noChangeCountBySig.set(sig, noChange);

    const failStreak = this.failStreakBySig.get(sig) ?? 0;
    const nextFailStreak =
      info.exitCode && info.exitCode !== 0 ? failStreak + 1 : 0;
    this.failStreakBySig.set(sig, nextFailStreak);

    if (repeats >= this.repeatToolSigEndTurnLimit) {
      const nudge = `SYSTEM FINAL WARNING:
You are repeating "${info.name}" with identical arguments:
  args: ${info.argsSig}
Stop retrying the same command. Either:
- Change the command/arguments,
- Run a different diagnostic, or
- @@user Ask for a clarifying input.`;
      return {
        nudge,
        endTurn: true,
        muteMs: this.defaultMuteMs,
        warnings: ["repeat-tool-args"],
      };
    }

    if (noChange >= 2) {
      const nudge = `SYSTEM:
The last ${noChange + 1} "${info.name}" runs produced the *same* result for the *same* arguments:
  args: ${info.argsSig}
This indicates a no‑progress loop. Switch strategy now:
- Try a different command or alter parameters
- Or @@user request guidance to unblock.`;
      return {
        nudge,
        endTurn: true,
        muteMs: this.defaultMuteMs,
        warnings: ["no-progress-tool-loop"],
      };
    }

    if (nextFailStreak >= 2) {
      const nudge = `SYSTEM:
Two consecutive failures from "${info.name}" for:
  args: ${info.argsSig}
Do NOT keep retrying blindly. Consider:
- Inspect error output and choose a different command,
- Or ask @@user for missing preconditions (paths, permissions, credentials).`;
      return { nudge, warnings: ["consecutive-tool-failures"] };
    }

    if (repeats === 2) {
      const nudge = `SYSTEM WARNING:
You're repeating "${info.name}" with the same arguments.
Avoid redundant calls; change inputs or pivot strategy.`;
      return { nudge, warnings: ["early-repeat"] };
    }

    return null;
  }

  // routing / broadcast hygiene --------------------------------------------
  guardCheck(
    route: GuardRouteKind,
    content: string,
    peers: string[]
  ): GuardDecision | null {
    const warnings: string[] = [];
    const norm = this.normalize(content);

    const hasExplicitTag = /@{2}(user|group|[A-Za-z0-9._-]+)/.test(content);
    if (!hasExplicitTag) warnings.push("no-explicit-tag");
    if (this.consecutiveNoToolCalls >= 2)
      warnings.push("several-turns-without-tools");

//    if (/apply_patch\s*<</i.test(content) || /<<<\s*PATCH/i.test(content)) {
//      const nudge = `SYSTEM:
//Do not use "apply_patch <<PATCH". To write files, emit a literal file block:
//
//##file:path/to/file.ext
//<content here>
//
//To run shell commands, call the "sh" tool with: {"cmd":"<command>"} .`;
//      return {
//        nudge,
//        suppressBroadcast: true,
//        muteMs: this.defaultMuteMs,
//        warnings: ["patch-dsl-misuse"],
//      };
//    }

    if (route === "group") {
      const lowSignal = this.isLowSignal(content);
      const nearDup = this.isNearDuplicateOfRecent(norm);

      if (lowSignal && nearDup) {
        const suggest = this.suggestHandoff(peers);
        const nudge = `SYSTEM:
Your last few @@group messages are low‑signal and very similar.
Switch tactics on your next turn:
- @@user Ask one concrete question to move work forward${
          suggest ? `, or\n- @@${suggest} DM a well‑scoped subtask` : ""
        }.`;
        this.rememberGroup(norm);
        return {
          nudge,
          suppressBroadcast: true,
          muteMs: this.defaultMuteMs,
          warnings: ["stagnant-group-broadcast"],
        };
      }

      if (lowSignal || nearDup) {
        const nudge = `SYSTEM WARNING:
Your message adds little new information. Prefer a specific ask or a concrete next step.`;
        this.rememberGroup(norm);
        return { nudge, warnings: ["weak-signal-group"] };
      }

      this.rememberGroup(norm);
    }

    return warnings.length ? { warnings } : null;
  }

  // idle fallback -----------------------------------------------------------
  onIdle?(state: {
    idleTicks: number;
    peers: string[];
    queuesEmpty: boolean;
  }): GuardDecision | null {
    if (!state.queuesEmpty) return null;
    if (state.idleTicks < 3) return null;

    const peerLine = state.peers.length
      ? `- "@@${state.peers[0]}" Ask that agent to run a specific command and report back.`
      : `- "@@user" Direct a specific agent with a command.`;

    const prompt = `(scheduler)
All agents are idle — no queued work and no actionable outputs.
Please provide the next *concrete* instruction.

Examples:
- "@@user Outline the next milestone and first task."
${peerLine}
- "Switch context to <topic> and set a single success criterion."`;

    return { askUser: prompt, warnings: ["scheduler-idle-advanced"] };
  }

  // helpers -----------------------------------------------------------------
  private suggestHandoff(peers: string[]): string | null {
    const candidate = peers.find((p) => p !== this.agentId);
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
    return (
      maxTok >= this.nearDupThreshold && maxTri >= this.triGramOverlapThreshold
    );
  }

  private normalize(s: string): string {
    return String(s || "")
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[`*_~>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private tokenize(s: string): string[] {
    return this.normalize(s).split(" ").filter(Boolean);
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
    return inter / Math.min(A.size, B.size);
  }

  private trigrams(s: string): Set<string> {
    const t = this.normalize(s).replace(/\s+/g, " ");
    const set = new Set<string>();
    for (let i = 0; i + 2 < t.length; i++) set.add(t.slice(i, i + 3));
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
      /following up/i,
      /checking in/i,
    ];
    if (pats.some((re) => re.test(text))) return true;
    const wc = s.split(" ").length;
    return wc <= 8;
  }

  private exampleForTool(name: string): string {
    if (name === "sh") {
      return `{"cmd":"ls -la"}  (example)
Return JSON: {"ok":boolean,"stdout":string,"stderr":string,"exit_code":number,"cmd":string}`;
    }
    return `${name}(<args...>)`;
  }
}
