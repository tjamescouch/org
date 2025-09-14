/* test/helpers/scheduling-harness.ts
 * Harness to test routing + scheduling together, deterministically.
 * - Uses production router + routeWithSideEffects.
 * - Pluggable `next` so we can feed the real scheduler.pickNext.
 */

import { Inbox } from "../../src/scheduler/inbox";
import { NoiseFilters } from "../../src/scheduler/filters";
import { routeWithSideEffects } from "../../src/scheduler/router";
import { makeRouter } from "../../src/routing/route-with-tags";

import type { ChatMessage } from "../../src/types";
import type { Responder, ChatResponse } from "../../src/scheduler/types";
import type { GuardDecision, GuardRouteKind } from "../../src/guardrails/guardrail";

export type ScriptFn = (prompt: ChatMessage[]) => string | undefined | Promise<string | undefined>;

/** Adapter signature the harness expects from a scheduler. */
export type NextFn = (
  inbox: Inbox,
  agents: ReadonlyArray<{ id: string }>,
  hint?: string,
) => string | undefined;

export class ScriptedResponder implements Responder {
  readonly id: string;
  private readonly script: ScriptFn;

  constructor(id: string, script: ScriptFn) {
    this.id = id;
    this.script = script;
  }

  // --- Optional guard hooks (unused in these tests, but typed) ---
  guardOnIdle?(_state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }): GuardDecision | null {
    return null;
  }
  guardCheck?(_route: GuardRouteKind, _content: string, _peers: string[]): GuardDecision | null {
    return null;
  }

  /** Harness convenience: produce one text line for the current prompt. */
  async run(prompt: ChatMessage[]): Promise<string | undefined> {
    return await this.script(prompt);
  }

  // --- Responder interface (satisfy production types) ---
  async save(): Promise<void> { /* no-op for tests */ }

  async respond(
    messages: ChatMessage[],
    _maxTools: number,
    _peers: string[],
    _abort: () => boolean,
  ): Promise<ChatResponse[]> {
    const out = await this.run(messages);
    return out == null ? [] : [{ message: out, toolsUsed: 0 }];
  }
}

export type TraceEvent =
  | { kind: "user->agent"; to: string; text: string }
  | { kind: "user->group"; to: string[]; text: string }
  | { kind: "agent->agent"; from: string; to: string; text: string }
  | { kind: "agent->group"; from: string; to: string[]; text: string }
  | { kind: "agent->user"; from: string; text: string };

export class SchedulingHarness {
  readonly agents: ScriptedResponder[];
  readonly inbox = new Inbox();
  readonly filters = new NoiseFilters();
  readonly trace: TraceEvent[] = [];

  private respondingHint: string | undefined;
  private lastUserDMTarget: string | undefined;
  private readonly next?: NextFn;

  constructor(agents: ScriptedResponder[], opts?: { next?: NextFn }) {
    this.agents = agents;
    this.next = opts?.next;
  }

  /** Route a user line using the production tag parser. */
  async userSends(text: string): Promise<void> {
    const router = makeRouter(
      {
        onAgent: async (_from, to, cleaned) => {
          if (cleaned) {
            this.inbox.push(to, { role: "user", from: "user", content: cleaned });
            this.trace.push({ kind: "user->agent", to, text: cleaned });
            this.lastUserDMTarget = to;
          }
        },
        onGroup: async (_from, cleaned) => {
          const content = cleaned ?? "";
          const toIds = this.agents.map(a => a.id);
          for (const to of toIds) {
            this.inbox.push(to, { role: "user", from: "user", content });
          }
          // record "user ->" for @@group.
          this.trace.push({ kind: "user->group", to: toIds, text: content });
        },
        onUser: async () => {},
        onFile: async () => {},
      },
      this.agents, // ScriptedResponder implements Responder
    );
    await router("user", text);
  }

  /** Drive until someone yields to the human or we hit step cap. */
  async runUntilUser(maxSteps = 16): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      const nextId = this.pickNextReady();
      if (!nextId) return;

      const agent = this.agents.find(a => a.id === nextId)!;
      const prompt = this.inbox.nextPromptFor(nextId);
      if (!prompt || prompt.length === 0) continue;

      const text = await agent.run(prompt);
      if (text == null) continue;

      const yieldToUser = await routeWithSideEffects(
        {
          agents: this.agents,
          enqueue: (toId, msg) => {
            this.inbox.push(toId, msg);
            this.trace.push({ kind: "agent->agent", from: agent.id, to: toId, text: msg.content });
          },
          setRespondingAgent: (id?: string) => { this.respondingHint = id; },
          applyGuard: async () => {},
          setLastUserDMTarget: (id: string) => { this.lastUserDMTarget = id; },
        },
        agent,
        text,
        this.filters,
        undefined,
      );

      if (yieldToUser) {
        this.trace.push({ kind: "agent->user", from: agent.id, text });
        return;
      }
    }
  }

  private pickNextReady(): string | undefined {
    if (this.next) {
      const id = this.next(this.inbox, this.agents, this.respondingHint);
      this.respondingHint = undefined;
      return id;
    }
    // Fallback: hint-first, then first-ready
    if (this.respondingHint && this.inbox.size(this.respondingHint) > 0) {
      const id = this.respondingHint;
      this.respondingHint = undefined;
      return id;
    }
    for (const a of this.agents) {
      if (this.inbox.size(a.id) > 0) return a.id;
    }
    return undefined;
  }

  /** Produce a compact flow label: e.g., "user -> alice -> user". */
  flow(): string {
    const arrow = " -> ";
    const parts: string[] = [];
    for (const ev of this.trace) {
      if (ev.kind === "user->group") {
        if (parts.length === 0 || parts[parts.length - 1] !== "user") parts.push("user");
      }
      if (ev.kind === "user->agent") parts.push("user", ev.to);
      if (ev.kind === "agent->agent") parts.push(ev.from, ev.to);
      if (ev.kind === "agent->user") parts.push(ev.from, "user");
    }
    const collapsed: string[] = [];
    for (const p of parts) if (!collapsed.length || collapsed[collapsed.length - 1] !== p) collapsed.push(p);
    return collapsed.join(arrow);
  }
}

/** Simple scripts */
export const sequence = (lines: string[]): ScriptFn => {
  let i = 0;
  return () => (i < lines.length ? lines[i++] : undefined);
};

export const echo = (suffix = ""): ScriptFn =>
  (prompt) => (prompt && prompt.length ? `${prompt[prompt.length - 1]!.content}${suffix}` : undefined);
