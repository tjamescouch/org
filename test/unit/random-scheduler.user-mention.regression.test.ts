// test/unit/random-scheduler.user-mention.regression.test.ts
import { describe, it, expect } from "bun:test";
import { FakeAgent, runSchedulerUntil } from "../_helpers/fake-agent";
import type { ChatMessage } from "../../src/types";
import { LookupAgent } from "../_helpers/lookup-agent";
import RandomScheduler from "../../src/scheduler/random-scheduler";
import { Responder, SchedulerOptions } from "../../src/scheduler/types";
import { waitFor } from "../_helpers/wait-for";

const byLastUser = (t: string) => (msgs: ChatMessage[]) =>
    (msgs[msgs.length - 1]?.role === "user") &&
    msgs[msgs.length - 1].content.toLowerCase().includes(t.toLowerCase());

function makeMsg(content: string, from = "User", role: ChatMessage["role"] = "user"): ChatMessage {
    return { content, from, role };
}

function makeScheduler(opts: Partial<SchedulerOptions> & {
    agents: Responder[];
    readUserLine?: () => Promise<string | undefined>;
}) {
    const scheduler = new RandomScheduler({
        agents: opts.agents,
        maxTools: opts.maxTools ?? 4,
        projectDir: process.cwd(),
        reviewMode: "ask",
        onAskUser: async () => "",     // never open TTY prompts in unit tests
        promptEnabled: false,          // we drive interjections explicitly here
        idleSleepMs: 5,
        onStreamStart: () => { },
        onStreamEnd: async () => { },
        shuffle: (xs) => xs,           // deterministic order
        readUserLine: opts.readUserLine,
    } as any);
    return scheduler;
}

describe("RandomScheduler – @@user regression guard", () => {
    it("Agent answers with @@user once and yields (no infinite loop)", async () => {
        // Alice: always reply to anything with a single final message to user and then be quiet.
        const alice = new LookupAgent("alice", {
            "*": "@@user Got it! Let me know what you'd like me to do.",
        });

        // Bob exists just to make routing realistic, but stays silent.
        const bob = new LookupAgent("bob", {});

        const scheduler = makeScheduler({ agents: [alice, bob] });

        // Start loop (it runs until we stop()).
        const run = scheduler.start();

        try {
            // Simulate the real program: a broadcast from the user.
            await scheduler.interject("hello everyone");

            // We should see exactly one call into Alice, none into infinite echo.
            await waitFor(() => alice.calls.length >= 1);

            // Give the scheduler a tick to route + settle, then stop it.
            await new Promise((r) => setTimeout(r, 25));
            scheduler.stop();
            await run;

            // Assertions: called once, and content contained @@user (final to user).
            expect(alice.calls.length).toBe(1);
            const lastInbox = alice.calls[0].inbox.map(m => m.content).join(" | ");
            expect(lastInbox).toContain("hello everyone");
        } finally {
            // Safety in case of unexpected branch.
            try { scheduler.stop(); } catch { }
            await run.catch(() => { });
        }
    });

    it("Explicit DM: user text is routed to the chosen default agent, not echoed back forever", async () => {
        // Alice replies once to a DM, then stays silent.
        const alice = new LookupAgent("alice", {
            "*": "@@user Sure — acknowledged.",
        });
        const bob = new LookupAgent("bob", {});

        const scheduler = makeScheduler({ agents: [alice, bob] });
        const run = scheduler.start();

        try {
            // DM the default target (alice) by using scheduler API. This mirrors the
            // behavior after a guardrail 'askUser' or a TTY bridge line.
            await scheduler.enqueueUserText("ok");
            await waitFor(() => alice.calls.length >= 1);

            scheduler.stop();
            await run;

            expect(alice.calls.length).toBe(1);
            expect(bob.calls.length).toBe(0);
        } finally {
            try { scheduler.stop(); } catch { }
            await run.catch(() => { });
        }
    });

    it("Agent-to-agent hop: @@bob from alice reaches bob exactly once", async () => {
        const alice = new LookupAgent("alice", {
            "*": "@@bob hi bob",   // single hop to bob
        });
        const bob = new LookupAgent("bob", {
            "hi bob": "@@user hey there", // bob finalizes to user
        });

        const scheduler = makeScheduler({ agents: [alice, bob], maxTools: 2 });
        const run = scheduler.start();

        try {
            await scheduler.interject("ping");
            await waitFor(() => alice.calls.length >= 1 && bob.calls.length >= 1);

            scheduler.stop();
            await run;

            expect(alice.calls.length).toBe(1);
            expect(bob.calls.length).toBe(1);
        } finally {
            try { scheduler.stop(); } catch { }
            await run.catch(() => { });
        }
    });

    it("agent greets user using @@user and does not DM itself", async () => {
        const alice = new FakeAgent("alice", [
            {
                when: byLastUser("hi"),
                reply: { kind: "mentionUser", text: "Hi! How can I help you today?" },
            },
        ]);

        const probe = await runSchedulerUntil({
            agents: [alice],
            interject: "hi",
            promptEnabled: false,
            deadlineMs: 1000,
            expect: () => alice.sent.some(m => m.content.startsWith("@@user")),
        });

        // The message we wanted:
        const m = alice.sent.find(x => x.content.startsWith("@@user"));
        expect(m).toBeDefined();
        expect(m!.content).toMatch(/@@user/i);

        // And crucially, it did NOT DM itself:
        const wrong = alice.sent.find(x => x.content.startsWith("@@alice"));
        expect(wrong).toBeUndefined();

        // Sanity: scheduler did not need to ask the user here.
        expect(probe.asks.length).toBe(0);
    });
});
