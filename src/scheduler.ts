// src/scheduler.ts
import { TagParser, TagPart } from "./utils/tag-parser";
import { makeRouter } from "./routing/route-with-tags";
import { C, Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";
import { shuffle } from "./utils/shuffle-array";
import { FileWriter } from "./io/file-writer";
import { ExecutionGate } from "./tools/execution-gate";
import { restoreStdin } from "./utils/restore-stdin";
import { GuardDecision, GuardRouteKind } from "./guardrails/guardrail";
import { ChatMessage } from "./types";


export interface Responder {
  id: string;
  respond(messages: ChatMessage[], maxTools: number, peers: string[], abortCallback: () => boolean): Promise<{ message: string; toolsUsed: number }>;
  guardOnIdle?: (state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }) => GuardDecision | null;
  guardCheck?: (route: GuardRouteKind, content: string, peers: string[]) => GuardDecision | null;
}

export class RoundRobinScheduler {
  private agents: Responder[];
  private maxTools: number;
  private running = false;
  private paused = false;
  private activeAgent: Responder | undefined;
  private respondingAgent: Responder | undefined;
  private draining = false;

  private readonly idlePromptEvery = 3;

  private inbox = new Map<string, ChatMessage[]>();
  private lastUserDMTarget: string | null = null;

  private userPromptFn: (fromAgent: string, content: string) => Promise<string | null>;
  private keepAlive: NodeJS.Timeout | null = null;

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
    this.keepAlive = setInterval(() => { /* keep process alive */ }, 30_000);

    let idleTicks = 0;
    while (this.running) {
      this.activeAgent = undefined;
      if (this.paused || this.draining) {

        await this.sleep(25); continue;
      }

      let didWork = false;

      const shuffled = shuffle(this.agents);
      while (shuffled.length > 0) {
        const agentOrUndeinfed: Responder | undefined = this.respondingAgent ?? shuffled.pop();

        if (!agentOrUndeinfed) {
          throw new Error("Expected agent not found.");
        }

        const a = agentOrUndeinfed;
          
        if (this.paused || !this.running) break;

        if (this.isMuted(a.id)) { Logger.debug(`muted: ${a.id}`); continue; }

        const messages = this.nextPromptFor(a.id);
        if (messages.length === 0) {
          Logger.debug(`no work for ${a.id}`);
          continue;
        }
        Logger.debug(`drained prompt for ${a.id}:`, JSON.stringify(messages));

        let remaining = this.maxTools;
        for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
          const peers = this.agents.map(x => x.id);
          Logger.debug(`ask ${a.id} (hop ${hop}) with budget=${remaining}`);
          this.activeAgent = a;
          const { message, toolsUsed } = await a.respond(messages, Math.max(0, remaining), peers, () => this.draining);
          this.activeAgent = undefined;
          Logger.debug(`${a.id} replied toolsUsed=${toolsUsed} message=`, JSON.stringify(message));

          const askedUser = await this.route(a, message);
          didWork = true;

          if (askedUser) {
            const userText = ((await this.userPromptFn(a.id, message)) ?? "").trim();
            if (userText) this.handleUserInterjection(userText);

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
        Logger.debug(`idle tick ${idleTicks}`);
        // Detect true "empty scheduler" condition and fall back to the user.
        if (idleTicks >= this.idlePromptEvery && this.areAllQueuesEmpty()) {
          const peers = this.agents.map(x => x.id);
          const dec = this.agents[0]?.guardOnIdle?.({ idleTicks, peers, queuesEmpty: true }) || null;
          const prompt = dec?.askUser || `(scheduler)\nAll agents are idle (no queued work). Please provide the next concrete instruction or question.`;
          const userText = ((await this.userPromptFn("scheduler", prompt)) ?? "").trim();
          if (userText) {
            this.handleUserInterjection(userText);
            idleTicks = 0;
          }
        }
      } else {
        idleTicks = 0;
      }

      await this.sleep(didWork ? 5 : 25);
    }

    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  };

  stop() { this.running = false; Logger.debug("stopped"); }
  pause() { this.paused = true; Logger.debug("paused"); }
  resume() { this.paused = false; Logger.debug("resumed"); }

  async drain(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    while (this.hasActiveAgent()) {
      Logger.info(C.magenta(`Waiting for agent to complete...`));

      await this.sleep(1000);
    }
    return true;
  }

  stopDraining(): void {
    this.draining = false;
  }

  isDraining(): boolean {
    return this.draining;
  }

  hasActiveAgent(): boolean {
    return !!this.activeAgent;
  }

  handleUserInterjection(text: string) {
    const target = this.lastUserDMTarget;
    // Record whatever assistant text we have before yielding
    const hasTag = text.match(/@@\w+/);

    const tagParts: TagPart[] = hasTag ? TagParser.parse(text) : [target ? { index: 0, kind: "agent", tag: target, content: text } : { index: 0, kind: "group", tag: "group", content: text }];

    for (const tagPart of tagParts) {
      if (tagPart.kind === "agent") {
        this.respondingAgent = this.agents.find(a => a.id === tagPart.tag);
        this.ensureInbox(tagPart.tag).push({ content: tagPart.content, role: "user", from: "User" });
        Logger.debug(`[user → @@${tagPart.tag}] ${text}`);
      } else {
        this.respondingAgent = this.agents.find(a => a.id === target);
        for (const a of this.agents) this.ensureInbox(a.id).push({ content: tagPart.content, role: "user", from: "User" });
        Logger.debug(`[user → @@group] ${text}`);
      }
    }
  }

  private ensureInbox(id: string): ChatMessage[] {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id)!;
  }

  private nextPromptFor(id: string): ChatMessage[] {
    return this.ensureInbox(id);
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
      onAgent: async (f, to, c) => { 
        this.respondingAgent = this.agents.find(a => a.id === to);
        if ((c || "").trim()) this.ensureInbox(to).push({ content: c, from: f, role: "user" }); 
      },
      onGroup: async (_f, c) => {
        const dec = fromAgent.guardCheck?.("group", c, this.agents.map(x => x.id)) || null;
        if (dec) await this.applyGuardDecision(fromAgent, dec);
        if (dec?.suppressBroadcast) {
          Logger.debug(`suppress @@group from ${fromAgent.id}`);
          return;
        }
        for (const a of this.agents) if (a.id !== fromAgent.id) { if ((c || "").trim()) this.ensureInbox(a.id).push({ content: c, from: fromAgent.id, role: "user" }); }
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
          // Restore the user's preferred TTY mode (raw no-echo while idle).
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
        for (const a of this.agents) if (a.id !== fromAgent.id) { if ((text || "").trim()) this.ensureInbox(a.id).push({ content: text, role: "user", from: fromAgent.id }); }
        Logger.debug(`${fromAgent.id} → @@group (implicit): ${text}`);
        Logger.debug(`${fromAgent.id} -> @@group (implicit):`, JSON.stringify(text));
      } else {
        Logger.debug(`suppress implicit @@group from ${fromAgent.id}`);
      }
    }
    return sawUser;
  }

  private async applyGuardDecision(agent: Responder, dec: GuardDecision) {
    if (dec.warnings && dec.warnings.length) {
      Logger.debug(`[guard][${agent.id}] ` + dec.warnings.join("; "));
    }
    if (dec.nudge) {
      this.ensureInbox(agent.id).push({ content: dec.nudge, from: "System", role: "system" });
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
