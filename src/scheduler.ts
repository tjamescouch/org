// src/scheduler.ts
import { TagParser } from "./utils/tag-parser";
import { makeRouter } from "./routing/route-with-tags";
import { C, Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";
import { FileWriter } from "./io/file-writer";
import { ExecutionGate } from "./tools/execution-gate";
import { restoreStdin } from "./utils/restore-stdin";
import type { GuardRouteKind, GuardDecision } from "./guardrails/guardrail";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) Logger.info("[DBG][scheduler]", ...a); }

/** Minimal interface all participant models must implement. */
export interface Responder {
  id: string;
  respond(usersPrompt: string, maxTools: number, peers: string[]): Promise<{ message: string; toolsUsed: number }>;
  /** Optional: scheduler can ask the agent's guard rail for idle fallback guidance. */
  guardOnIdle?: (state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }) => GuardDecision | null;
  /** Optional: expose agent-specific guard rail to the scheduler. */
  guardCheck?: (route: GuardRouteKind, content: string, peers: string[]) => GuardDecision | null;
}

/** Round-robin scheduler that routes @@tags and supports hotkey interjection. */
export class RoundRobinScheduler {
  private agents: Responder[];
  private maxTools: number;
  private running = false;
  private paused = false;

  /** After this many idle scans, we ask the user for help. */
  private readonly idlePromptEvery = 3;

  private inbox = new Map<string, string[]>();
  private lastUserDMTarget: string | null = null;

  private userPromptFn: (fromAgent: string, content: string) => Promise<string | null>;
  private keepAlive: NodeJS.Timeout | null = null;

  // Anti-loop: we respect per-agent mute windows recommended by GuardRail
  private mutedUntil = new Map<string, number>();

  constructor(opts: {
    agents: Responder[];
    maxTools: number;
    onAskUser: (fromAgent: string, content: string) => Promise<string | null>;
  }) {
    this.agents = opts.agents;
    this.maxTools = Math.max(0, opts.maxTools);
    this.userPromptFn = opts.onAskUser;
    for (const a of this.agents) this.ensureInbox(a.id);
  }

  start = async (): Promise<void> => {
    this.running = true;
    // Keep-alive to avoid “exit 0” on empty loops in some runtimes
    this.keepAlive = setInterval(() => { /* no-op */ }, 30_000);

    let idleTicks = 0;
    while (this.running) {
      if (this.paused) { await this.sleep(25); continue; }

      let didWork = false;

      for (const a of this.agents) {
        if (this.paused || !this.running) break;

        if (this.isMuted(a.id)) { dbg(`muted: ${a.id}`); continue; }

        const basePrompt = this.nextPromptFor(a.id);
        if (!basePrompt) {
          dbg(`no work for ${a.id}`);
          continue;
        }
        dbg(`drained prompt for ${a.id}:`, JSON.stringify(basePrompt));

        let remaining = this.maxTools;
        // multiple hops if the model requests tools
        for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
          const peers = this.agents.map(x => x.id);
          dbg(`ask ${a.id} (hop ${hop}) with budget=${remaining}`);
          const { message, toolsUsed } = await a.respond(basePrompt, Math.max(0, remaining), peers);
          dbg(`${a.id} replied toolsUsed=${toolsUsed} message=`, JSON.stringify(message));

          const askedUser = await this.route(a, message);
          didWork = true;

          if (askedUser) {
            const userText = (await this.userPromptFn(a.id, message)) ?? "";
            if (userText.trim()) this.handleUserInterjection(userText.trim());
            break;
          }

          if (toolsUsed > 0) {
            remaining = Math.max(0, remaining - toolsUsed);
            if (remaining <= 0) break;
          } else {
            break;
          }
        }
      }

      if (!didWork) {
        idleTicks++;
        dbg(`idle tick ${idleTicks}`);
        // Detect true "empty scheduler" condition and fall back to the user.
        if (idleTicks >= this.idlePromptEvery && this.areAllQueuesEmpty()) {
          const peers = this.agents.map(x => x.id);
          // Ask any agent's guard (first one) to craft the prompt; fall back to a sane default.
          const dec = this.agents[0]?.guardOnIdle?.({ idleTicks, peers, queuesEmpty: true }) || null;
          const prompt = dec?.askUser || `(scheduler)\nAll agents are idle (no queued work). Please provide the next concrete instruction or question.`;
          const userText = (await this.userPromptFn("scheduler", prompt)) ?? "";
          if (userText.trim()) {
            this.handleUserInterjection(userText.trim());
            idleTicks = 0; // reset on user interjection
          }
        }
      } else {
        idleTicks = 0;
      }

      await this.sleep(didWork ? 5 : 25);
    }

    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  };

  stop() { this.running = false; }
  pause() { this.paused = true; dbg("paused"); }
  resume() { this.paused = false; dbg("resumed"); }

  handleUserInterjection(text: string) {
    const target = this.lastUserDMTarget;
    if (target) {
      this.ensureInbox(target).push(text);
      Logger.debug(`[user → @@${target}] ${text}`);
    } else {
      for (const a of this.agents) this.ensureInbox(a.id).push(text);
      Logger.debug(`[user → @@group] ${text}`);
    }
  }

  private ensureInbox(id: string) {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id)!;
  }

  private nextPromptFor(id: string): string | null {
    const q = this.ensureInbox(id);
    if (q.length === 0) return null;
    return q.splice(0, q.length).join("\n");
  }

  // --------------------------- Routing + GuardRail --------------------------

  private isMuted(id: string): boolean {
    const until = this.mutedUntil.get(id) ?? 0;
    return Date.now() < until;
  }

  private mute(id: string, ms: number) {
    this.mutedUntil.set(id, Date.now() + Math.max(250, ms));
  }

  private async route(fromAgent: Responder, text: string): Promise<boolean> {
    const parts = TagParser.parse(text || "");
    let sawUser = false;
    for (const t of parts) if (t.kind === "user") sawUser = true;

    const router = makeRouter({
      onAgent: async (_f, to, c) => { if ((c || "").trim()) this.ensureInbox(to).push(c); },
      onGroup: async (_f, c) => {
        // Let the agent’s guard rail weigh in before broadcasting
        const dec = fromAgent.guardCheck?.("group", c, this.agents.map(x => x.id)) || null;
        if (dec) this.applyGuardDecision(fromAgent, dec);
        if (dec?.suppressBroadcast) {
          dbg(`suppress @@group from ${fromAgent.id}`);
          return;
        }
        for (const a of this.agents) if (a.id !== fromAgent.id) { if ((c || "").trim()) this.ensureInbox(a.id).push(c); }
      },
      onUser: async (_f, _c) => { this.lastUserDMTarget = fromAgent.id; },
      onFile: async (_f, name, c) => {
        const { cleaned } = extractCodeGuards(c);
        const cmd = `${c}\n***** Write to file? [y/N] ${name}\n`;
        const wasRaw = (process.stdin as any)?.isRaw;
          try {
          if (wasRaw) process.stdin.setRawMode(false);
          await ExecutionGate.gate(cmd);
          const res = await FileWriter.write(name, cleaned);
              Logger.info(C.yellow(`${cleaned}`));
          Logger.info(C.magenta(`Written to ${res.path} (${res.bytes} bytes)`));
        } catch (err: any) {
          Logger.error(`File write failed: ${err?.message || err}`);
          } finally {
            restoreStdin(!!wasRaw);
        }
      }
    });

    await router(fromAgent.id, text);

    // If no tags and not @@user, treat as implicit group broadcast
    if (!sawUser && parts.length === 0) {
      const dec = fromAgent.guardCheck?.("group", text, this.agents.map(x => x.id)) || null;
      if (dec) await this.applyGuardDecision(fromAgent, dec);
      if (!dec?.suppressBroadcast) {
        for (const a of this.agents) if (a.id !== fromAgent.id) { if ((text || "").trim()) this.ensureInbox(a.id).push(text); }
        Logger.debug(`${fromAgent.id} → @@group (implicit): ${text}`);
        dbg(`${fromAgent.id} -> @@group (implicit):`, JSON.stringify(text));
      } else {
        dbg(`suppress implicit @@group from ${fromAgent.id}`);
      }
    }
    return sawUser;
  }

  private async applyGuardDecision(agent: Responder, dec: GuardDecision) {
    if (dec.warnings && dec.warnings.length) {
      Logger.debug(`[guard][${agent.id}] ` + dec.warnings.join("; "));
    }
    if (dec.nudge) {
      this.ensureInbox(agent.id).push(dec.nudge);
    }
    if (dec.muteMs && dec.muteMs > 0) {
      this.mute(agent.id, dec.muteMs);
    }
    if (dec.askUser) {
      const userText = (await this.userPromptFn(agent.id, dec.askUser)) ?? "";
      if (userText.trim()) this.handleUserInterjection(userText.trim());
    }
  }

  private areAllQueuesEmpty(): boolean {
    for (const a of this.agents) {
      const q = this.inbox.get(a.id) || [];
      if (q.length > 0) return false;
    }
    return true;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
