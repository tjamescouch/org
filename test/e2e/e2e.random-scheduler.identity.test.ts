/* test/e2e/e2e.random-scheduler.identity.test.ts */
import { describe, it, expect } from "bun:test";
import { SchedulingHarness, ScriptedResponder, sequence, NextFn } from "../helpers/scheduling-harness";
import { RandomScheduler } from "../../src/scheduler/random-scheduler";
import type { AskUserFn, Responder } from "../../src/scheduler/types";
import type { ISandboxSession } from "../../src/sandbox/types";
import { R } from "../../src/runtime/runtime";

const identityShuffle = <T>(arr: T[]) => arr;

function makeSandboxStub(): ISandboxSession {
    return {
        runDir: "/tmp/org-test",
        async start() { },
        async exec(_cmd: string) { return { ok: true, exit: 0, stdoutFile: "/dev/null", stderrFile: "/dev/null" }; },
        async finalize() { return { manifestPath: "/tmp/org-test/manifest.json" }; },
        async destroy(_opts?: { removeScratch?: boolean }) { },
    };
}

/** Adapter: feed real scheduler.pickNext(inbox, agents, hint) into the harness. */
function asNextFn(rr: RandomScheduler, agents: ReadonlyArray<Responder>): NextFn {
    return (inbox, _agentsFromHarness, hint) => rr.pickNext(inbox, agents, hint);
}

describe("RandomScheduler + router (identity shuffle => deterministic)", () => {
    it("group fan-out rotates alice -> bob -> carol (each yields to user)", async () => {
        const alice = new ScriptedResponder("alice", sequence(["@@user A"]));
        const bob = new ScriptedResponder("bob", sequence(["@@user B"]));
        const carol = new ScriptedResponder("carol", sequence(["@@user C"]));
        const agents: Responder[] = [alice, bob, carol];

        const rr = new RandomScheduler({
            onStreamStart: () => { },
            onStreamEnd: () => { },
            agents,
            maxTools: 0,
            projectDir: R.cwd(),
            onAskUser: (async () => { }) as AskUserFn,
            promptEnabled: false,
            idleSleepMs: 0,
            reviewMode: "never",
            shuffle: identityShuffle,   // <-- round-robin
            sandbox: makeSandboxStub(),
        });

        const h = new SchedulingHarness([alice, bob, carol], { next: asNextFn(rr, agents) });

        await h.userSends("@@group. hi all");
        await h.runUntilUser(); // alice
        expect(h.flow()).toBe("user -> alice -> user");

        await h.runUntilUser(); // bob
        expect(h.flow()).toBe("user -> alice -> user -> bob -> user");

        await h.runUntilUser(); // carol
        expect(h.flow()).toBe("user -> alice -> user -> bob -> user -> carol -> user");
    });

    it("hint respected: alice nudges bob → scheduler picks bob next", async () => {
        const alice = new ScriptedResponder("alice", sequence(["@@bob ping"]));
        const bob = new ScriptedResponder("bob", sequence(["@@user pong"]));
        const agents: Responder[] = [alice, bob];

        const rr = new RandomScheduler({
            onStreamStart: () => { },
            onStreamEnd: () => { },
            agents,
            maxTools: 0,
            projectDir: R.cwd(),
            onAskUser: async () => { },
            promptEnabled: false,
            idleSleepMs: 0,
            reviewMode: "never",
            shuffle: identityShuffle,
            sandbox: makeSandboxStub(),
        });

        const h = new SchedulingHarness([alice, bob], { next: asNextFn(rr, agents) });

        await h.userSends("@@group. begin");
        await h.runUntilUser();

        expect(h.flow()).toBe("user -> alice -> bob -> user");
    });

    it("DM path: user -> @@bob -> @@user", async () => {
        const bob = new ScriptedResponder("bob", sequence(["@@user ack"]));
        const agents: Responder[] = [bob];

        const rr = new RandomScheduler({
            onStreamStart: () => { },
            onStreamEnd: () => { },
            agents,
            maxTools: 0,
            projectDir: R.cwd(),
            onAskUser: async () => { },
            promptEnabled: false,
            idleSleepMs: 0,
            reviewMode: "never",
            shuffle: identityShuffle,
            sandbox: makeSandboxStub(),
        });

        const h = new SchedulingHarness([bob], { next: asNextFn(rr, agents) });

        await h.userSends("@@bob hi");
        await h.runUntilUser();

        expect(h.flow()).toBe("user -> bob -> user");
    });
});
