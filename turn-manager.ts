// turn-manager.ts
import type { ChatRoom } from "./chat-room";
import type { AgentModel } from "./agent-model";

// Time-bounded user-control gate (set by main.ts during interject)
function userControlActive(): boolean {
  const until: number = (globalThis as any).__USER_CONTROL_UNTIL || 0;
  if (!until) return false;
  const now = Date.now();
  if (now < until) return true;
  // TTL expired — clear it
  (globalThis as any).__USER_CONTROL_UNTIL = 0;
  return false;
}

export interface TurnManagerOpts {
  tickMs?: number;            // scheduler cadence
  turnTimeoutMs?: number;     // per-turn watchdog
  idleBackoffMs?: number;     // when agent has nothing to say
  proactiveMs?: number;       // allow a lightweight proactive turn this often even with no unread
}

export class TurnManager {
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean[] = [];
  private lastIdle: number[] = [];
  private lastProbe: number[] = [];   // last time we allowed a proactive turn per agent
  private paused = false;
  private lastSkipLog = 0;

  constructor(private room: ChatRoom, private agents: AgentModel[], private opts: TurnManagerOpts = {}) {
    const n = agents.length;
    this.running = Array(n).fill(false);
    this.lastIdle = Array(n).fill(0);
    this.lastProbe = Array(n).fill(0);
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

    // Global, time-bounded pause when user is interjecting
    if (userControlActive()) {
      const now = Date.now();
      if (!this.lastSkipLog || now - this.lastSkipLog > 1000) {
        try { (globalThis as any).__log?.("[skip] user control active; skipping scheduler tick", "yellow"); } catch {}
        this.lastSkipLog = now;
      }
      return;
    }

    const n = this.agents.length;
    if (!n) return;

    // Priority 1: if there’s a fresh user message, schedule all agents once (but one per tick)
    const userBurst = this.room.hasFreshUserMessage();
    const start = this.i;

    for (let step = 0; step < n; step++) {
      const k = (start + step) % n;
      const agent = this.agents[k];

      // Skip if already running
      if (this.running[k]) continue;
      const now = Date.now();
      const backoff = this.opts.idleBackoffMs ?? 1000;
      const proactiveMs = this.opts.proactiveMs ?? 3000; // allow a periodic proactive tick
      const hasUnread = agent.hasUnread();
      const allowProactive = !hasUnread && !userBurst && (now - this.lastProbe[k] >= proactiveMs);

      // Skip if neither unread nor eligible for a proactive tick
      if (!userBurst && !hasUnread && !allowProactive) continue;

      // Respect idle backoff if we recently found nothing to do
      if (now - this.lastIdle[k] < backoff) continue;

      // Time-box the turn (shorter default than 30s for responsiveness)
      this.running[k] = true;
      const watchdog = setTimeout(() => agent.abortCurrentTurn?.("watchdog"), this.opts.turnTimeoutMs ?? 8_000);

      try {
        const didWork = await agent.takeTurn();
        if (!didWork) {
          this.lastIdle[k] = Date.now();
        }
        // If this was a proactive attempt (no unread before), record probe time
        if (!hasUnread && !userBurst) {
          this.lastProbe[k] = Date.now();
        }
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