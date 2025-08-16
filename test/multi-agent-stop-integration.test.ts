
// test/multi-agent-stop-integration.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Logger } from "../src/ui/logger";
import { Model } from "../src/core/entity/model";

type Step =
  | { kind: "tool"; ms: number; label?: string }
  | { kind: "say"; text: string; to?: string };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Scripted agent with explicit inbox + attachRoom usage. */
class ScriptedAgent extends Model {
  private steps: Step[];
  private idx = 0;
  private started = false;
  private inbox: any[] = [];
  private onTurn?: (who: string, step: Step) => void;

  delivered = 0;

  constructor(id: string, steps: Step[], onTurn?: (who: string, step: Step) => void) {
    super(id);
    this.steps = steps;
    this.onTurn = onTurn;
  }

  async receiveMessage(m: any) { if (m?.from !== this.id) { this.started = true; this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.started = true; this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.started = true; this.inbox.push(m); this.delivered++; } }

  hasUnread() { return this.started && this.idx < this.steps.length && this.inbox.length > 0; }

  async takeTurn(): Promise<boolean> {
    if (!this.hasUnread()) return false;
    this.inbox.shift();

    const step = this.steps[this.idx++];
    this.onTurn?.(this.id, step);

    if (step.kind === "tool") {
      Logger.debug(`[script:${this.id}] tool ${step.label ?? ""} (${step.ms}ms)`);
      await sleep(step.ms);
    } else {
      Logger.debug(`[script:${this.id}] say: ${step.text}`);
      await this.broadcast(step.text, step.to);
    }
    if (this.idx < this.steps.length) this.inbox.push({ from: this.id, content: "tick" });
    return true;
  }
}

test("full convo then user says Stop -> scheduler pauses (no more chatter)", async () => {
  Logger.info("[integration-stop] starting");

  const room = new ChatRoom();

  const turnLog: string[] = [];
  const tap = (who: string, step: Step) => {
    const tag = step.kind === "tool" ? `tool:${step.label ?? ""}` : `say`;
    turnLog.push(`${who}:${tag}`);
  };

  const alice = new ScriptedAgent("alice",
    [{ kind: "tool", ms: 50, label: "prep-1" },
     { kind: "tool", ms: 50, label: "prep-2" },
     { kind: "say",  text: "@group Alice done with tools." }],
    tap);

  const bob = new ScriptedAgent("bob",
    [{ kind: "tool", ms: 60, label: "scan" },
     { kind: "say",  text: "@group Bob ready." }],
    tap);

  const carol = new ScriptedAgent("carol",
    [{ kind: "tool", ms: 40, label: "notes" },
     { kind: "say",  text: "@group Carol summary." }],
    tap);

  // Explicitly attach, in case addModel doesn't
  (alice as any).attachRoom?.(room);
  (bob as any).attachRoom?.(room);
  (carol as any).attachRoom?.(room);

  room.addModel(alice as any);
  room.addModel(bob as any);
  room.addModel(carol as any);

  const tm = new TurnManager(room, [alice as any, bob as any, carol as any], {
    tickMs: 20, idleBackoffMs: 0, proactiveMs: 10_000, turnTimeoutMs: 2_000
  });
  // if TM has binder, bind now
  (tm as any)._bindOnce?.();

  tm.start();

  // Kickoff
  await room.broadcast("User", "Kickoff");

  // Ensure delivery happened
  const tDeliver = Date.now();
  while ((alice.delivered + bob.delivered + carol.delivered) === 0 && Date.now() - tDeliver < 1500) {
    await sleep(25);
  }

  // Wait until at least one scripted step happened
  const t0 = Date.now();
  while (turnLog.length < 1 && Date.now() - t0 < 3000) await sleep(25);
  expect(turnLog.length).toBeGreaterThan(0);

  // Interject: Stop -> pause immediately
  await room.broadcast("User", "Stop");
  tm.pause();
  const turnsAtStop = turnLog.length;

  await sleep(500);
  expect(turnLog.length).toBe(turnsAtStop);

  // Resume briefly; if steps remain they can proceed now
  tm.resume();
  const t1 = Date.now();
  while (Date.now() - t1 < 600 && turnLog.length === turnsAtStop) await sleep(25);

  tm.stop();
}, 12000);
