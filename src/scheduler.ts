import { TagParser } from "./utils/tag-parser";
import { makeRouter } from "./routing/route-with-tags";
import { Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";
import { FileWriter } from "./io/file-writer";
import { ExecutionGate } from "./tools/execution-gate";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) console.error("[DBG][scheduler]", ...a); }

function restoreStdin(raw: boolean) {
  try {
    if (raw && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    dbg("stdin restored (raw:", raw, ")");
  } catch (e) {
    console.error("[DBG] failed to restore stdin:", e);
  }
}

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

  constructor(opts: {
    agents: Responder[];
    maxTools: number;
    onAskUser: (fromAgent: string, content: string) => Promise<string | null>;
  }) {
    this.agents = opts.agents;
    this.maxTools = Math.max(0, opts.maxTools);
    this.userPromptFn = opts.onAskUser;
    for (const a of this.agents) this.ensureInbox(a.id);
  }

  start = async (): Promise<void> => {
    this.running = true;
    // Keep-alive to avoid “exit 0” on empty loops in some runtimes
    //ping
    this.keepAlive = setInterval(() => { /* no-op */ }, 30_000);
    setTimeout(() => {
      //pong
      this.keepAlive = setInterval(() => { /* no-op */ }, 30_000);
    }, 1000)

    let idleTicks = 0;
    while (this.running) {
      if (this.paused) { await this.sleep(25); continue; }

      let didWork = false;

      for (const a of this.agents) {
        if (this.paused || !this.running) break;

        const basePrompt = this.nextPromptFor(a.id);
        if (!basePrompt) {
          dbg(`no work for ${a.id}`);
          continue;
        }
        dbg(`drained prompt for ${a.id}:`, JSON.stringify(basePrompt));

        let remaining = this.maxTools;
        // multiple hops if the model requests tools
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

  private async route(from: string, text: string): Promise<boolean> {
    const parts = TagParser.parse(text || "");
    let sawUser = false;
    for (const t of parts) if (t.kind === "user") sawUser = true;

    const router = makeRouter({
      onAgent: async (_f, to, c) => { this.ensureInbox(to).push(c); },
      onGroup: async (_f, c) => { for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(c); },
      onUser: async (_f, c) => { this.lastUserDMTarget = from; },
      onFile: async (_f, name, c) => {
        const { cleaned } = extractCodeGuards(c);
        const cmd = `${c}\n***** Write to file? [y/N] ${name}\n`;
        const wasRaw = (process.stdin as any)?.isRaw;
        try {
          if (wasRaw) process.stdin.setRawMode(false);
          await ExecutionGate.gate(cmd);
          const res = await FileWriter.write(name, cleaned);
          Logger.info(`wrote ${res.path} (${res.bytes} bytes)`);
        } catch (err: any) {
          Logger.error(`file write failed: ${err?.message || err}`);
        } finally {
          restoreStdin(!!wasRaw);
        }
      }
    });

    await router(from, text);

    if (!sawUser && parts.length === 0) {
      for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(text);
      Logger.debug(`${from} → @@group (implicit): ${text}`);
      dbg(`${from} -> @@group (implicit):`, JSON.stringify(text));
    }
    return sawUser;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
