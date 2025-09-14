/* test/helpers/scheduling-harness.ts
 * Minimal harness to test routing + scheduling together.
 * - Deterministic by default (first-ready), or pluggable via a picker.
 * - In-memory Inbox.
 * - Responder scripts return a single text per tick.
 */

import * as path from "node:path";
import type { ChatMessage } from "../../src/types"; // adjust if your path differs

// These imports matched your earlier run; keep them as-is in your repo.
import { Inbox } from "../../src/scheduler/inbox";
import { NoiseFilters } from "../../src/scheduler/filters";
import { routeWithSideEffects } from "../../src/scheduler/router";
import { makeRouter } from "../../src/routing/route-with-tags";
import type { ChatResponse, Responder } from "../../src/scheduler/types";
import type { GuardDecision, GuardRouteKind } from "../../src/guardrails/guardrail";

export type ScriptFn = (prompt: ChatMessage[]) => string | undefined | Promise<string | undefined>;

export class ScriptedResponder implements Responder {
    readonly id: string;
    private readonly script: ScriptFn;
    guardCheck?: (kind: GuardRouteKind, content: string, peers: string[]) => GuardDecision | null;

    constructor(id: string, script: ScriptFn) {
        this.id = id;
        this.script = script;
    }

    async save(): Promise<void> { 
        throw new Error("Method not implemented.");
    }

    respond(messages: ChatMessage[], maxTools: number, peers: string[], abortCallback: () => boolean): Promise<ChatResponse[]> {
        throw new Error("Method not implemented.");
    }

    guardOnIdle?: ((state: { idleTicks: number; peers: string[]; queuesEmpty: boolean; }) => GuardDecision | null) | undefined;

    async run(prompt: ChatMessage[]): Promise<string | undefined> {
        return await this.script(prompt);
    }
}

export type TraceEvent =
    | { kind: "user->agent"; to: string; text: string }
    | { kind: "user->group"; to: string[]; text: string }
    | { kind: "agent->agent"; from: string; to: string; text: string }
    | { kind: "agent->group"; from: string; to: string[]; text: string }
    | { kind: "agent->user"; from: string; text: string };

/** Optional scheduler/selector injection (e.g., round-robin). */
export interface NextPicker {
    pickNext(inbox: Inbox, agents: { id: string }[], hint?: string): string | undefined;
}

export class SchedulingHarness {
    readonly agents: ScriptedResponder[];
    readonly inbox = new Inbox();
    readonly filters = new NoiseFilters();

    private respondingHint: string | undefined;
    private lastUserDMTarget: string | undefined;
    private picker?: NextPicker;

    readonly trace: TraceEvent[] = [];

    constructor(agents: ScriptedResponder[], opts?: { picker?: NextPicker }) {
        this.agents = agents;
        this.picker = opts?.picker;
    }

    /** Seed a user line and route it with the canonical tag parser (@@alice, @@group., @@user). */
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
                    // FIX: record the user hop so flows start with "user -> ..."
                    this.trace.push({ kind: "user->group", to: toIds, text: content });
                },
                onUser: async () => {
                    /* user->@@user is a no-op for input */
                },
                onFile: async () => {
                    /* ignored in tests */
                },
            },
            this.agents.map(a => ({ id: a.id })) as unknown as Responder[],
        );

        await router("user", text);
    }

    /** Run until a model yields to the human or we hit maxSteps. */
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
                    agents: this.agents as unknown as Responder[],
                    enqueue: (toId, msg) => {
                        this.inbox.push(toId, msg);
                        this.trace.push({ kind: "agent->agent", from: agent.id, to: toId, text: msg.content });
                    },
                    setRespondingAgent: (id?: string) => {
                        this.respondingHint = id;
                    },
                    applyGuard: async () => {
                        /* optional */
                    },
                    setLastUserDMTarget: (id: string) => {
                        this.lastUserDMTarget = id;
                    },
                },
                agent as unknown as Responder,
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

    /** Deterministic choice: injected picker if provided; else first agent with queued messages, with hint preference. */
    private pickNextReady(): string | undefined {
        // Prefer injected picker (e.g., round-robin).
        if (this.picker) {
            const id = this.picker.pickNext(this.inbox, this.agents, this.respondingHint);
            this.respondingHint = undefined;
            return id;
        }

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

    /** Human-readable flow like "user -> alice -> user" (ignores group fan-outs except for the initial 'user'). */
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
        // Collapse consecutive duplicates
        const collapsed: string[] = [];
        for (const p of parts) {
            if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== p) collapsed.push(p);
        }
        return collapsed.join(arrow);
    }
}

/** Script helpers */
export const sequence = (lines: string[]): ScriptFn => {
    let i = 0;
    return () => (i < lines.length ? lines[i++] : undefined);
};

export const echo = (suffix = ""): ScriptFn =>
    (prompt) => (prompt && prompt.length ? `${prompt[prompt.length - 1]!.content}${suffix}` : undefined);

/** A simple round-robin picker you can inject into the harness for tests. */
export const roundRobinPicker = (order?: string[]): NextPicker => {
    let cursor = 0;
    return {
        pickNext(inbox, agents, hint) {
            const ids = order && order.length === agents.length ? order : agents.map(a => a.id);

            if (hint && ids.includes(hint) && inbox.size(hint) > 0) {
                cursor = (ids.indexOf(hint) + 1) % ids.length;
                return hint;
            }

            const n = ids.length;
            for (let i = 0; i < n; i++) {
                const id = ids[(cursor + i) % n];
                if (inbox.size(id) > 0) {
                    cursor = (cursor + i + 1) % n;
                    return id;
                }
            }
            return undefined;
        },
    };
};
