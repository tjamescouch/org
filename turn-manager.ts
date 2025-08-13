// turn-manager.ts
import type { ChatRoom } from "./chat-room";
import type { AgentModel } from "./agent-model";

export interface TurnManagerOpts {
  tickMs?: number;            // scheduler cadence
  turnTimeoutMs?: number;     // per-turn watchdog
  idleBackoffMs?: number;     // when agent has nothing to say
}

export class TurnManager {
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean[] = [];
  private lastIdle: number[] = [];
  private paused = false;

  constructor(private room: ChatRoom, private agents: AgentModel[], private opts: TurnManagerOpts = {}) {
    const n = agents.length;
    this.running = Array(n).fill(false);
    this.lastIdle = Array(n).fill(0);
  }

  pause()  { this.paused = true; }
  resume() { this.paused = false; }

  start() {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 400;
    const loop = async () => {
      try { await this.tick(); } catch {}
      this.timer = setTimeout(loop, tickMs);
    };
    this.timer = setTimeout(loop, tickMs);
  }
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One scheduling step */
  private async tick() {
    if (this.paused) return;

    const n = this.agents.length;
    if (!n) return;

    // Priority 1: if there’s a fresh user message, schedule all agents once (but one per tick)
    const userBurst = this.room.hasFreshUserMessage();
    const start = this.i;

    for (let step = 0; step < n; step++) {
      const k = (start + step) % n;
      const agent = this.agents[k];

      // Skip if already running, or recently idle-backed off
      if (this.running[k]) continue;
      const backoff = this.opts.idleBackoffMs ?? 1000;
      if (Date.now() - this.lastIdle[k] < backoff) continue;

      // Only schedule if agent has unread work OR we’re in a userBurst
      if (!userBurst && !agent.hasUnread()) continue;

      // Time-box the turn
      this.running[k] = true;
      const watchdog = setTimeout(() => agent.abortCurrentTurn?.("watchdog"), this.opts.turnTimeoutMs ?? 30_000);

      try {
        const didWork = await agent.takeTurn();
        if (!didWork) this.lastIdle[k] = Date.now();
      } catch {
        // swallow; the agent reports errors to the log
      } finally {
        clearTimeout(watchdog);
        this.running[k] = false;
      }

      this.i = (k + 1) % n;   // next round starts after this agent
      return;                 // one agent per tick
    }
  }
}