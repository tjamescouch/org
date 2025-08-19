import { TagParser } from "./utils/tag-parser";
import { makeRouter } from "./routing/route-with-tags";
import { C, Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";
import { FileWriter } from "./io/file-writer";
import { ExecutionGate } from "./tools/execution-gate";
import { restoreStdin } from "./utils/restore-stdin";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) Logger.info("[DBG][scheduler]", ...a); }

/** Minimal interface all participant models must implement. */
export interface Responder {
  id: string;
  respond(usersPrompt: string, maxTools: number, peers: string[]): Promise<{ message: string; toolsUsed: number }>;
}

/** Round-robin scheduler that routes @@tags and supports hotkey interjection. */
export class RoundRobinScheduler {
  private agents: Responder[];
  private maxTools: number;
  private running = false;
  private paused = false;

  private inbox = new Map<string, string[]>();
  private lastUserDMTarget: string | null = null;

  private userPromptFn: (fromAgent: string, content: string) => Promise<string | null>;
  private keepAlive: NodeJS.Timeout | null = null;

  // ---- Anti-loop state ------------------------------------------------------
  /** last normalized text + repeat count per agent */
  private repeats = new Map<string, { norm: string; count: number; at: number }>();
  /** muted agents (skip scheduling) until given epoch ms */
  private mutedUntil = new Map<string, number>();

  /** configurable thresholds */
  private stagnationRepeatThreshold = 3;  // ≥3 near-duplicates
  private lowSignalRepeatThreshold = 2;   // ≥2 if the text is low-signal
  private muteMs = 1500;                  // cool-off so others can progress

  constructor(opts: {
    agents: Responder[];
    maxTools: number;
    onAskUser: (fromAgent: string, content: string) => Promise<string | null>;
    // Optional knobs
    stagnationRepeatThreshold?: number;
    lowSignalRepeatThreshold?: number;
    muteMs?: number;
  }) {
    this.agents = opts.agents;
    this.maxTools = Math.max(0, opts.maxTools);
    this.userPromptFn = opts.onAskUser;

    // Optional tuning
    if (opts.stagnationRepeatThreshold) this.stagnationRepeatThreshold = Math.max(2, opts.stagnationRepeatThreshold);
    if (opts.lowSignalRepeatThreshold)  this.lowSignalRepeatThreshold  = Math.max(2, opts.lowSignalRepeatThreshold);
    if (opts.muteMs)                    this.muteMs                    = Math.max(500, opts.muteMs);

    for (const a of this.agents) this.ensureInbox(a.id);
  }

  start = async (): Promise<void> => {
    this.running = true;
    this.keepAlive = setInterval(() => { /* no-op */ }, 30_000);

    let idleTicks = 0;
    while (this.running) {
      if (this.paused) { await this.sleep(25); continue; }

      let didWork = false;

      for (const a of this.agents) {
        if (this.paused || !this.running) break;

        // Skip muted agents briefly to collapse feedback loops
        if (this.isMuted(a.id)) { dbg(`muted: ${a.id}`); continue; }

        const basePrompt = this.nextPromptFor(a.id);
        if (!basePrompt) {
          dbg(`no work for ${a.id}`);
          continue;
        }
        dbg(`drained prompt for ${a.id}:`, JSON.stringify(basePrompt));

        let remaining = this.maxTools;
        for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
          const peers = this.agents.map(x => x.id);
          dbg(`ask ${a.id} (hop ${hop}) with budget=${remaining}`);
          const { message, toolsUsed } = await a.respond(basePrompt, Math.max(0, remaining), peers);
          dbg(`${a.id} replied toolsUsed=${toolsUsed} message=`, JSON.stringify(message));

          const askedUser = await this.route(a.id, message);
          didWork = true;

          if (askedUser) {
            const userText = (await this.userPromptFn(a.id, message)) ?? "";
            if (userText.trim()) this.handleUserInterjection(userText.trim());
            break;
          }

          if (toolsUsed > 0) {
            remaining = Math.max(0, remaining - toolsUsed);
            if (remaining <= 0) break;
          } else {
            break;
          }
        }
      }

      if (!didWork) { idleTicks++; dbg(`idle tick ${idleTicks}`); }
      else idleTicks = 0;

      await this.sleep(didWork ? 5 : 25);
    }

    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  };

  stop() { this.running = false; }
  pause() { this.paused = true; dbg("paused"); }
  resume() { this.paused = false; dbg("resumed"); }

  handleUserInterjection(text: string) {
    const target = this.lastUserDMTarget;
    if (target) {
      this.ensureInbox(target).push(text);
      Logger.debug(`[user → @@${target}] ${text}`);
    } else {
      for (const a of this.agents) this.ensureInbox(a.id).push(text);
      Logger.debug(`[user → @@group] ${text}`);
    }
  }

  private ensureInbox(id: string) {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id)!;
  }

  private nextPromptFor(id: string): string | null {
    const q = this.ensureInbox(id);
    if (q.length === 0) return null;
    return q.splice(0, q.length).join("\n");
  }

  // --------------------------- Routing + Anti-loop ---------------------------

  private normalize(s: string): string {
    return String(s || "")
      .toLowerCase()
      .replace(/[`*_~>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private jaccardSimilar(a: string, b: string): number {
    if (!a || !b) return 0;
    const sa = new Set(a.split(" "));
    const sb = new Set(b.split(" "));
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    const union = new Set([...sa, ...sb]).size;
    return union === 0 ? 0 : inter / union;
  }

  private isLowSignalText(text: string): boolean {
    const s = this.normalize(text);
    if (s.length < 12) return true;
    if (s.length > 240) return false;
    const pats = [
      /what can i help/i,
      /how can i help/i,
      /what would you like/i,
      /i'?m here.*ready to help/i,
      /let me know/i,
      /sounds good.*just let me know/i,
    ];
    return pats.some((re) => re.test(text)) || s.split(" ").length <= 8;
  }

  /**
   * Track repeats; return true if the agent appears stuck.
   * - near-duplicate N times, or
   * - low-signal text repeated a smaller number of times
   */
  private isStuck(from: string, text: string): boolean {
    const norm = this.normalize(text);
    const prev = this.repeats.get(from);
    if (!prev) {
      this.repeats.set(from, { norm, count: 1, at: Date.now() });
      return false;
    }

    const sim = this.jaccardSimilar(prev.norm, norm);
    const nearDup = sim >= 0.80;
    const count = nearDup ? prev.count + 1 : 1;
    this.repeats.set(from, { norm, count, at: Date.now() });

    if (nearDup && count >= this.stagnationRepeatThreshold) return true;
    if (this.isLowSignalText(text) && count >= this.lowSignalRepeatThreshold) return true;
    return false;
  }

  private isMuted(id: string): boolean {
    const until = this.mutedUntil.get(id) ?? 0;
    return Date.now() < until;
  }

  private mute(id: string, ms: number) {
    this.mutedUntil.set(id, Date.now() + ms);
  }

  private async route(from: string, text: string): Promise<boolean> {
    const parts = TagParser.parse(text || "");
    let sawUser = false;
    for (const t of parts) if (t.kind === "user") sawUser = true;

    const router = makeRouter({
      onAgent: async (_f, to, c) => { this.ensureInbox(to).push(c); },
      onGroup: async (_f, c) => {
        // Anti-loop: if the sender is stuck and still posting to @@group,
        // do not broadcast. Instead, nudge and briefly mute the sender so
        // other agents (or the user) can progress.
        if (this.isStuck(from, c)) {
          const peers = this.agents.filter(x => x.id !== from).map(x => `@@${x.id}`).join(" or ");
          const nudge =
`SYSTEM NOTE:
You are repeating low-signal @@group messages. On your next turn do ONE of:
- @@user <ask one concrete, single-sentence question>, or
- ${peers} <delegate a specific task with details>.
Do NOT reply to @@group.`;
          this.ensureInbox(from).push(nudge);
          this.mute(from, this.muteMs);
          Logger.debug(C.yellow(`[anti-loop] nudged + muted ${from} for ${this.muteMs}ms`));
          return;
        }
        for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(c);
      },
      onUser: async (_f, _c) => { this.lastUserDMTarget = from; },
      onFile: async (_f, name, c) => {
        const { cleaned } = extractCodeGuards(c);
        const cmd = `${c}\n***** Write to file? [y/N] ${name}\n`;
        const wasRaw = (process.stdin as any)?.isRaw;
        try {
          if (wasRaw) process.stdin.setRawMode(false);
          await ExecutionGate.gate(cmd);
          const res = await FileWriter.write(name, cleaned);
          Logger.info(C.yellow(`${cleaned}`));
          Logger.info(C.magenta(`Written to ${res.path} (${res.bytes} bytes)`));
        } catch (err: any) {
          Logger.error(`File write failed: ${err?.message || err}`);
        } finally {
          restoreStdin(!!wasRaw);
        }
      }
    });

    await router(from, text);

    // Parser always returns at least one part, so this fallback is rarely used.
    if (!sawUser && parts.length === 0) {
      for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(text);
      Logger.debug(`${from} → @@group (implicit): ${text}`);
      dbg(`${from} -> @@group (implicit):`, JSON.stringify(text));
    }
    return sawUser;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
