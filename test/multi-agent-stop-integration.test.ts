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

/**
 * Scripted agent with a real Model id and an internal inbox.
 * - Starts after any non-self message arrives
 * - Runs one step per tick
 * - Self-enqueues a synthetic "tick" message while steps remain
 */
class ScriptedAgent extends Model {
  private steps: Step[];
  private idx = 0;
  private started = false;
  private inbox: any[] = [];
  private onTurn?: (who: string, step: Step) => void;

  constructor(id: string, steps: Step[], onTurn?: (who: string, step: Step) => void) {
    super(id);
    this.steps = steps;
    this.onTurn = onTurn;
  }

  async receiveMessage(m: any) {
    if (m?.from !== this.id) {
      this.started = true;
      this.inbox.push(m);
    }
  }

  hasUnread(): boolean {
    return this.started && this.idx < this.steps.length && this.inbox.length > 0;
  }

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

    // Keep the agent eligible for the next step without needing external messages.
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
    [{ kind: "tool", ms: 60, label: "prep-1" },
     { kind: "tool", ms: 60, label: "prep-2" },
     { kind: "say",  text: "@group Alice done with tools." }],
    tap);

  const bob = new ScriptedAgent("bob",
    [{ kind: "tool", ms: 80, label: "scan" },
     { kind: "say",  text: "@group Bob ready." }],
    tap);

  const carol = new ScriptedAgent("carol",
    [{ kind: "tool", ms: 50, label: "notes" },
     { kind: "say",  text: "@group Carol summary." }],
    tap);

  room.addModel(alice as any);
  room.addModel(bob as any);
  room.addModel(carol as any);

  const tm = new TurnManager(room, [alice as any, bob as any, carol as any], {
    tickMs: 25,
    turnTimeoutMs: 2000,
    idleBackoffMs: 150,
    proactiveMs: 5000, // keep proactives out of the way
  });

  tm.start();

  // 1) User starts conversation
  await room.broadcast("User", "Kickoff");

  // Wait until at least one scripted step happened
  const t0 = Date.now();
  while (turnLog.length < 1 && Date.now() - t0 < 4000) {
    await sleep(25);
  }
  expect(turnLog.length).toBeGreaterThan(0);

  // 6) User: "Stop" -> pause immediately
  await room.broadcast("User", "Stop");
  tm.pause();

  const turnsAtStop = turnLog.length;

  // 7) While paused, no more turns
  await sleep(600);
  expect(turnLog.length).toBe(turnsAtStop);

  // Sanity: resume briefly; if steps remain they can proceed now
  tm.resume();
  const r0 = Date.now();
  while (Date.now() - r0 < 800 && turnLog.length === turnsAtStop) {
    await sleep(25);
  }
  tm.stop();
}, 12000);
