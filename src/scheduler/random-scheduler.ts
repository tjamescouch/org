/**
 * RandomScheduler (type-safe, Inbox-backed, fail-fast)
 * ---------------------------------------------------
 * Implements IScheduler.
 * - Uses Inbox (ChatMessage routing).
 * - Yields when idle so TTY input isn't starved.
 * - **Validates** ChatMessage[] before agent.respond() and throws with a
 *   precise error if any element is malformed. Nothing is “fixed silently”.
 */

import { Logger } from "../logger";
import type {
  IScheduler,
  SchedulerAgent,
  SchedulerOptions,
  ChatMessage,
} from "./scheduler";
import Inbox from "./inbox";

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"] as const);

function assertChatMessages(agentId: string, msgs: ChatMessage[]): void {
  if (!Array.isArray(msgs)) {
    throw new Error(`agent='${agentId}': messages must be an array`);
  }
  msgs.forEach((m, i) => {
    const where = `agent='${agentId}' messages[${i}]`;
    if (!m || typeof m !== "object") {
      throw new Error(`${where} is not an object`);
    }
    if (!VALID_ROLES.has(m.role as any)) {
      throw new Error(`${where}.role invalid: ${String(m.role)}`);
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      throw new Error(`${where}.content missing/empty`);
    }
    if (/^\s*undefined\s*:/i.test(m.content)) {
      throw new Error(`${where}.content corrupted (starts with 'undefined:')`);
    }
    if (m.from !== undefined && (typeof m.from !== "string" || !m.from.trim())) {
      throw new Error(`${where}.from invalid`);
    }
    if (m.to !== undefined && (typeof m.to !== "string" || !m.to.trim())) {
      throw new Error(`${where}.to invalid`);
    }
  });
}

function summarizeMessages(msgs: ChatMessage[]) {
  return msgs.map((m, i) => ({
    i,
    role: m.role,
    contentLen: m.content.length,
    from: m.from,
    to: m.to,
  }));
}

export default class RandomScheduler implements IScheduler {
  private readonly agents: SchedulerAgent[];
  private readonly maxTools: number;
  private readonly onAskUser: SchedulerOptions["onAskUser"];
  private promptEnabled: boolean;

  private running = false;
  private draining = false;

  private rr = 0; // round-robin cursor
  private inbox = new Inbox();

  constructor(opts: SchedulerOptions) {
    this.agents = opts.agents;
    this.maxTools = Math.max(0, opts.maxTools ?? 20);
    this.onAskUser = opts.onAskUser;
    this.promptEnabled = !!opts.promptEnabled;
  }

  /** Convert text to a valid ChatMessage or throw; enqueue it. */
  async enqueueUserText(text: string, opts?: { to?: string; from?: string }): Promise<void> {
    if (typeof text !== "string") {
      throw new Error(`enqueueUserText: text must be string; got ${typeof text}`);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("enqueueUserText: refusing to enqueue empty text");
    }
    if (/^\s*undefined\s*:/i.test(trimmed)) {
      throw new Error("enqueueUserText: input appears corrupted (starts with 'undefined:')");
    }

    this.inbox.enqueue({
      role: "user",
      content: trimmed,
      from: opts?.from,
      to: opts?.to ?? "@group",
    });
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.promptEnabled && this.inbox.size() === 0) {
      await this.safeAskUser(
        "scheduler",
        "[scheduler]\nAll agents are idle — no queued work and no actionable outputs.\nPlease provide the next *concrete* instruction."
      );
      this.promptEnabled = false;
    }

    while (this.running) {
      if (this.draining && this.inbox.size() === 0) {
        this.running = false;
        break;
      }

      if (this.agents.length === 0 || this.inbox.size() === 0) {
        await this.sleep(25);
        continue;
      }

      const agent = this.pickAgent();

      if (!this.inbox.hasWork(agent.id)) {
        // try next agent quickly
        this.rr = (this.rr + 1) % this.agents.length;
        await this.sleep(1);
        continue;
      }

      const messages = this.inbox.nextPromptFor(agent.id);
      // Fail fast on bad shape instead of masking
      assertChatMessages(agent.id, messages);

      if (process.env.ORG_TRACE === "1") {
        Logger.info(`[TRACE] sched.nextPromptFor -> ${agent.id}`, summarizeMessages(messages));
      }

      try {
        const peers = this.agents.map(a => a.id);
        const shouldAbort = () => !this.running || this.draining;

        Logger.debug?.(`${agent.id} start {`, {
          promptChars: messages.reduce((n, m) => n + m.content.length, 0),
          maxTools: this.maxTools,
        }, "}");

        const out = await agent.respond(messages, this.maxTools, peers, shouldAbort);

        if (typeof out === "string" && out.trim().length > 0) {
          Logger.info(`${agent.id} ...`);
          Logger.info(out);
          Logger.info(`[${agent.id}] wrote. No tools used.`);
        }
      } catch (e) {
        Logger.error?.(`Agent '${agent.id}' failed:`, (e as any)?.message || e);
      }

      await this.sleep(1);
    }
  }

  async stop(): Promise<void> { this.running = false; }
  async drain(): Promise<void> { this.draining = true; }

  // -------------- internals --------------
  private pickAgent(): SchedulerAgent {
    if (this.agents.length === 0) throw new Error("No agents configured");
    const a = this.agents[this.rr % this.agents.length];
    return a;
  }

  private async safeAskUser(fromAgent: string, content: string): Promise<void> {
    try { await this.onAskUser(fromAgent, content); }
    catch (e) { Logger.error?.("onAskUser failed, continuing:", (e as any)?.message || e); }
  }

  private sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
}
