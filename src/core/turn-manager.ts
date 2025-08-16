// turn-manager.ts
import type { ChatRoom } from "./chat-room";
import type { AgentModel } from "./entity/agent-model";
import { Logger } from "../ui/logger";

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
  pokeAfterMs?: number;       // after this idle time, poke agents once
}

export class TurnManager {
  private __kickPending = false;
  private __kickSoon() {
    if (this.__kickPending) return;
    this.__kickPending = true;
    setTimeout(() => { this.__kickPending = false; try { this.run?.(); } catch {} }, 0);
  }
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean[] = [];
  private lastIdle: number[] = [];
  private lastProbe: number[] = [];   // last time we allowed a proactive turn per agent
  private noWorkTicks = 0;            // consecutive ticks with no scheduled work
  private lastAnyWorkTs = Date.now(); // last time an agent actually ran
  private paused = false;
  private lastSkipLog = 0;

  constructor(private room: ChatRoom, private agents: AgentModel[], private opts: TurnManagerOpts = {}) {
    const n = agents.length;
    this.running = Array(n).fill(false);
    this.lastIdle = Array(n).fill(0);
    this.lastProbe = Array(n).fill(0);
    this.noWorkTicks = 0;
    this.lastAnyWorkTs = Date.now();
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
    // [watchdog-patch] call
    this.__watchdogPokeAfterIdle();
if (this.paused) return;

    // [watchdog-patch] ensure idle poke can fire during backpressure
  {
    const pokeAfter = this.opts.pokeAfterMs ?? 30_000;
    const idleMs = Date.now() - this.lastAnyWorkTs;
    if (idleMs >= pokeAfter) {
      this.lastAnyWorkTs = Date.now();
      const nowIso = new Date().toISOString();
      for (let i = 0; i < this.agents.length; i++) {
        (this.agents[i] as any).enqueueFromRoom({
          ts: nowIso, role: "user", from: "User", content: "(resume)", read: false,
        });
      }
    }
  }
// Global, time-bounded pause when user is interjecting
    if (userControlActive()) {
      const now = Date.now();
      if (!this.lastSkipLog || now - this.lastSkipLog > 1000) {
        try { (globalThis as any).__log?.("[skip] user control active; skipping scheduler tick", "yellow"); } catch {}
        this.lastSkipLog = now;
      }
      return;
    }
    // Global transport backpressure: if provider is busy OR cooling, skip this tick
    try {
      const t: any = (globalThis as any).__transport;
      const cap = (t && typeof t.cap === "number" ? t.cap : 1);
      // busy if the number of in-flight requests meets or exceeds the configured cap.
      const inflight = t && typeof t.inflight === "function" ? t.inflight() : 0;
      const busy = inflight >= cap;
      const cooling = !!(t && typeof t.cooling === "function" && t.cooling());
      if ((busy || cooling)) {
        const now = Date.now();
        if (!this.lastSkipLog || now - this.lastSkipLog > 1000) {
          try {
            (globalThis as any).__log?.(
              `[backpressure] provider busy/cooling (inflight=${inflight}, cap=${cap}) — deferring scheduling`,
              "yellow"
            );
          } catch {}
          this.lastSkipLog = now;
        }
        return;
      }
    } catch {}

    const n = this.agents.length;
    if (!n) return;

    // Priority 1: if there’s a fresh user message, schedule all agents once (but one per tick)
    const userBurst = this.room.hasFreshUserMessage();
    const start = this.i;

    let didSchedule = false;

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
      {
        // Debug: log scheduling decisions.  This helps identify which
        // agents get turns during the multi-agent integration test.  We
        // include basic state to understand why an agent is chosen.
        Logger.debug(
          `[DEBUG turn-manager] scheduling agent=${agent?.id} hasUnread=${hasUnread} ` +
            `userBurst=${userBurst} allowProactive=${allowProactive} backoffElapsed=${now - this.lastIdle[k]}ms`
        );
      }
      this.running[k] = true;
      const watchdog = setTimeout(() => agent.abortCurrentTurn?.("watchdog"), this.opts.turnTimeoutMs ?? 8_000);

      try {
        const didWork = await agent.takeTurn();
      // ensure next agent gets scheduled promptly
      this.__kickSoon();
        didSchedule = true;
        this.lastAnyWorkTs = Date.now();

        if (!didWork) {
          this.lastIdle[k] = Date.now();
        }
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

    if (!didSchedule) {
      // Low-frequency watchdog: if *nothing* has run for a while, poke agents once.
      const idleMs = Date.now() - this.lastAnyWorkTs;
      const POKE_AFTER_MS = this.opts.pokeAfterMs ?? 30_000; // 30s default
      if (idleMs >= POKE_AFTER_MS) {
        this.lastAnyWorkTs = Date.now();
        const nowIso = new Date().toISOString();
        for (let k = 0; k < n; k++) {
          try {
            (this.agents[k] as any).enqueueFromRoom({
              ts: nowIso,
              role: "user",
              from: "User",
              content: "(resume)",
              read: false,
            });
          } catch {}
        }
        try { (globalThis as any).__log?.("[watchdog] idle ≥ 30s — poked agents with (resume)", "yellow"); } catch {}
      }
    } else {
      // Reset the idle timestamp whenever we schedule work
      this.noWorkTicks = 0;
      this.lastAnyWorkTs = Date.now();
    }

    // Starvation guard: if nothing has run for a while (no agent scheduled),
    // re-arm probes so proactive turns can fire again.
    const STARVE_MS = Math.max(5000, (this.opts.proactiveMs ?? 3000) * 2);
    if (Date.now() - this.lastAnyWorkTs > STARVE_MS) {
      for (let k = 0; k < n; k++) this.lastProbe[k] = 0;
      this.lastAnyWorkTs = Date.now();
      try { (globalThis as any).__log?.("[watchdog] starvation guard reset probes", "yellow"); } catch {}
    }
  }
}

// [watchdog-patch] proto method
(TurnManager as any).prototype.__watchdogPokeAfterIdle = function () {
  try {
    const env = (typeof process !== "undefined" && process?.env) ? process.env : (globalThis as any);
    const DBG = env && (env.TM_DEBUG === "1" || env.TM_DEBUG === 1);

    const pokeAfter = (this?.opts?.pokeAfterMs ?? 30000);
    const idleMs = Date.now() - (this?.lastAnyWorkTs ?? 0);

    if (DBG) console.debug?.("[tm/watchdog] idleMs=%d pokeAfter=%d agents=%d", idleMs, pokeAfter, this?.agents?.length ?? -1);

    if (idleMs >= pokeAfter) {
      const nowIso = new Date().toISOString();
      let poked = 0;
      for (let i = 0; i < (this?.agents?.length ?? 0); i++) {
        const tgt: any = this.agents[i];
        if (tgt && typeof tgt.enqueueFromRoom === "function") {
          tgt.enqueueFromRoom({ ts: nowIso, role: "user", from: "User", content: "(resume)", read: false });
          poked++;
        }
      }
      this.lastAnyWorkTs = Date.now();
      if (DBG) console.debug?.("[tm/watchdog] poked=%d", poked);
    }
  } catch (e) {
    // Never let logging or a bad agent explode the scheduler
    try { console.debug?.("[tm/watchdog] error:", String(e && (e.stack || e))); } catch {}
  }
};
