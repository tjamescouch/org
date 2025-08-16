// test/multi-agent-stop-integration.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";

type Step =
    | { kind: "tool"; ms: number; label?: string }
    | { kind: "say"; text: string; to?: string };

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Scripted fake agent used only in tests. It mimics a Model-like object:
 * - reacts when it has unread messages
 * - performs "tool" steps (just waits) and "say" steps (broadcasts to the room)
 * - runs one step per scheduler tick
 */
function makeScriptedModel(name: string, steps: Step[], taps: { onTurn?: (who: string, step: Step) => void } = {}) {
    const inbox: any[] = [];
    let idx = 0;

    return {
        name,
        hasUnread() {
            return inbox.length > 0 && idx < steps.length;
        },
        onRoomMessage(_m: any) {
            inbox.push(_m);
        },
        async takeTurn(room: ChatRoom) {
            const step = steps[idx++];
            if (!step) return false;
            taps.onTurn?.(name, step);

            if (step.kind === "tool") {
                Logger.debug(`[script:${name}] tool step ${step.label ?? ""} waiting ${step.ms}ms`);
                await delay(step.ms);
                return true;
            } else {
                Logger.debug(`[script:${name}] say: ${step.text}`);
                await room.broadcast(name, step.text, step.to);
                return true;
            }
        },
    };
}

test("full convo then user says Stop -> scheduler pauses (no more chatter)", async () => {
    Logger.info("[integration-stop] starting");

    const room = new ChatRoom();

    const turns: Array<string> = [];
    const origBroadcast = (room as any).broadcast.bind(room);
    // Tap assistant messages for assertions and visibility in failures
    (room as any).broadcast = async (from: string, content: string, directTo?: string) => {
        if (from !== "User") {
            turns.push(`${from}:${content}`);
        }
        return origBroadcast(from, content, directTo);
    };

    const alice = makeScriptedModel("alice", [
        { kind: "tool", ms: 60, label: "prep-1" },
        { kind: "tool", ms: 60, label: "prep-2" },
        { kind: "say", text: "@group Alice done with tools." },
    ], { onTurn: (w) => Logger.debug(`[integration-stop] turn -> ${w}`) });

    const bob = makeScriptedModel("bob", [
        { kind: "tool", ms: 80, label: "scan" },
        { kind: "say", text: "@group Bob ready." },
    ], { onTurn: (w) => Logger.debug(`[integration-stop] turn -> ${w}`) });

    const carol = makeScriptedModel("carol", [
        { kind: "tool", ms: 50, label: "notes" },
        { kind: "say", text: "@group Carol summary." },
    ], { onTurn: (w) => Logger.debug(`[integration-stop] turn -> ${w}`) });

    room.addModel(alice as any);
    room.addModel(bob as any);
    room.addModel(carol as any);

    // Faster cadence to keep the test snappy
    const tm = new TurnManager(room, [alice as any, bob as any, carol as any], {
        tickMs: 25,
        turnTimeoutMs: 2000,
        idleBackoffMs: 150,
        proactiveMs: 5000, // don't let proactives interfere here
    });

    tm.start();

    // 1) User starts conversation
    await room.broadcast("User", "Kickoff");

    // Wait until at least one assistant message lands (Alice likely finishes first)
    const t0 = Date.now();
    while (turns.length < 1 && Date.now() - t0 < 4000) {
        await delay(25);
    }
    expect(turns.length).toBeGreaterThanOrEqual(1);

    // 6) User interjects "Stop" and scheduler pauses immediately
    await room.broadcast("User", "Stop");
    tm.pause();

    const turnsAtStop = turns.length;

    // 7) While paused, NO further assistant outputs should appear
    await delay(500);
    expect(turns.length).toBe(turnsAtStop);

    // Resume briefly (sanity: if work remained, it can proceed now)
    tm.resume();
    const resumeWaitStart = Date.now();
    while (Date.now() - resumeWaitStart < 800 && turns.length === turnsAtStop) {
        await delay(25);
    }
    tm.stop();

    Logger.info(`[integration-stop] saw ${turns.length} assistant messages; paused at ${turnsAtStop}`);
}, 10000);

