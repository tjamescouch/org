import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";
import { Model } from "../src/core/entity/model";

type Step =
  | { kind: "tool"; ms: number; label?: string }
  | { kind: "say"; text: string; to?: string };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * A test-only scripted agent that **does not** depend on room.dequeue/peek.
 * It runs steps once it has observed at least one delivered message.
 */
class ScriptedAgent extends Model {
  private steps: Step[];
  private idx = 0;
  private onTurn?: (who: string, step: Step) => void;
  private _room: ChatRoom | null = null;

  delivered = 0;

  constructor(id: string, steps: Step[], onTurn?: (who: string, step: Step) => void) {
    super(id);
    this.steps = steps;
    this.onTurn = onTurn;
  }

  attachRoom(room: ChatRoom) { this._room = room; }

  // Count any inbound message that isn't from self
  async receiveMessage(m: any) { if (m?.from !== this.id) this.delivered++; }
  onRoomMessage(m: any)        { if (m?.from !== this.id) this.delivered++; }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) this.delivered++; }

  hasUnread(): boolean {
    // In tests, treat "saw at least one message" as permission to run scripted steps.
    return this.delivered > 0 && this.idx < this.steps.length;
  }

  async takeTurn(): Promise<boolean> {
    if (!(this.delivered > 0) || this.idx >= this.steps.length) return false;

    const step = this.steps[this.idx++];
    this.onTurn?.(this.id, step);

    if (step.kind === "tool") {
      Logger.debug?.(`[script:${this.id}] tool ${step.label ?? ""}`);
      await sleep(step.ms);
    } else {
      const r = this._room as any;
      const selfBroadcast = (this as any).broadcast;
      if (typeof selfBroadcast === "function") {
        await selfBroadcast.call(this, step.text, step.to);
      } else if (r && typeof r.broadcast === "function") {
        await r.broadcast(this.id, step.text, step.to);
      }
    }

    // Return true to signal "worked this turn"
    return true;
  }
}

test("full convo then user says Stop -> scheduler pauses (no more chatter)", async () => {
  (globalThis as any).__PAUSE_INPUT = false;
  Logger.info?.("[integration-stop] starting");

  const room = new ChatRoom();
  const turnLog: string[] = [];
  const tap = (who: string, step: Step) =>
    turnLog.push(`${who}:${step.kind === "tool" ? `tool:${step.label ?? ""}` : "say"}`);

  const alice = new ScriptedAgent("alice",
    [{ kind: "tool", ms: 60, label: "prep-1" },
     { kind: "tool", ms: 60, label: "prep-2" },
     { kind: "say",  text: "@group Alice done with tools." }],
    tap);

  const bob = new ScriptedAgent("bob",
    [{ kind: "tool", ms: 40, label: "scan" },
     { kind: "say",  text: "@group Bob ready." }],
    tap);

  const carol = new ScriptedAgent("carol",
    [{ kind: "tool", ms: 30, label: "notes" },
     { kind: "say",  text: "@group Carol summary." }],
    tap);

  alice.attachRoom(room); bob.attachRoom(room); carol.attachRoom(room);
  room.addModel(alice as any);
  room.addModel(bob as any);
  room.addModel(carol as any);

  const tm = new TurnManager(room, [alice as any, bob as any, carol as any], {
    tickMs: 20, idleBackoffMs: 0, proactiveMs: 10_000, turnTimeoutMs: 2_000,
  });
  (tm as any)._bindOnce?.();
  tm.start();

  // (1) Kick off the conversation
  await room.broadcast("User", "Kickoff");

  // (2) Wait until at least one scripted step has executed
  const t0 = Date.now();
  while (turnLog.length < 1 && Date.now() - t0 < 3000) await sleep(25);
  if (turnLog.length === 0) {
    tm.stop();
    throw new Error(`[integration-stop] no steps observed; delivered={a:${alice.delivered},b:${bob.delivered},c:${carol.delivered}}`);
  }
  expect(turnLog.length).toBeGreaterThan(0);

  // (3) User interjects "Stop" and we pause the scheduler
  await room.broadcast("User", "Stop");
  tm.pause();

  const turnsAtStop = turnLog.length;
  await sleep(500);

  // (4) Ensure there is no additional chatter while paused
  expect(turnLog.length).toBe(turnsAtStop);

  tm.stop();
}, 15000);
