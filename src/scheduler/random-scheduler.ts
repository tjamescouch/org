/**
 * RandomScheduler (type-safe, Inbox-backed, with strict validation)
 * -----------------------------------------------------------------
 * - Implements IScheduler.
 * - Uses Inbox (ChatMessage routing).
 * - Yields when idle so TTY is responsive.
 * - **Validates** ChatMessage[] before agent.respond() and throws with a
 *   helpful error if any element is malformed (so we don't mask bugs).
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

function summarizeMessages(msgs: ChatMessage[]): unknown {
  return msgs.map((m, i) => ({
    i,
    role: m?.role,
    contentLen: typeof m?.content === "string" ? m.content.length : undefined,
    from: m?.from,
    to: m?.to,
  }));
}

function assertValidMessages(agentId: string, msgs: ChatMessage[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as Partial<ChatMessage>;
    const where = `agent='${agentId}' messages[${i}]`;
    if (!m || typeof m !== "object") {
      throw new Error(`${where} is not an object`);
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role as any)) {
      throw new Error(`${where}.role is invalid: ${String(m.role)}`);
    }
    if (typeof m.content !== "string") {
      throw new Error(`${where}.content is not a string`);
    }
  }
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

  async enqueueUserText(text: string, opts?: { to?: string; from?: string }): Promise<void> {
    // source of truth for user input → ChatMessage
    const msg: ChatMessage = {
      role: "user",
      content: String(text ?? ""),
      from: opts?.from,
      to: opts?.to ?? "@group",
    };
    this.inbox.enqueue(msg);
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
      if (messages.length === 0) {
        await this.sleep(1);
        continue;
      }

      // ---- strict validation & tracing ----
      if (process.env.ORG_TRACE === "1") {
        Logger.info(`[TRACE] sched.nextPromptFor -> ${agent.id}`, summarizeMessages(messages));
      }
      assertValidMessages(agent.id, messages);
      // -------------------------------------

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
