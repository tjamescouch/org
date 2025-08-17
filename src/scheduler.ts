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

/** Minimal interface all participant models must implement. */
export interface Responder {
  id: string;
  /** peers are the other agent ids */
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

  // ask the human for input when an agent says @@user
  private userPromptFn: (fromAgent: string, content: string) => Promise<string | null>;

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

  /** --- public control API --- */
  start = async (): Promise<void> => {
    this.running = true;

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
            // wait for the user's reply then route it
            const userText = (await this.userPromptFn(a.id, message)) ?? "";
            const trimmed = userText.trim();
            dbg(`@@user reply received:`, JSON.stringify(trimmed));
            if (trimmed) this.handleUserInterjection(trimmed);
            break; // yield to next agent after talking to user
          }

          if (toolsUsed > 0) {
            remaining = Math.max(0, remaining - toolsUsed);
            dbg(`${a.id} tool budget now ${remaining}`);
            if (remaining <= 0) break; // tool budget exhausted
            // loop again to let the model see tool output and respond
          } else {
            break; // no tools => yield
          }
        }
      }

      const pending = this.totalPending();
      if (didWork) {
        idleTicks = 0;
      } else {
        idleTicks++;
        dbg(`idle tick ${idleTicks} (pending=${pending})`);
      }

      // Idle wait without burning CPU; remain interactive for hotkey 'i'
      await this.sleep(didWork ? 5 : 25);
    }
  };

  stop() { this.running = false; }
  pause() { this.paused = true; dbg("paused"); }
  resume() { this.paused = false; dbg("resumed"); }

  /** User pressed 'i' or otherwise typed — route to lastDM if available, else broadcast. */
  handleUserInterjection(text: string) {
    const target = this.lastUserDMTarget;
    if (target) {
      this.ensureInbox(target).push(text);
      Logger.debug(`[user → @@${target}] ${text}`);
      dbg(`user DM to ${target}:`, JSON.stringify(text));
    } else {
      for (const a of this.agents) this.ensureInbox(a.id).push(text);
      Logger.debug(`[user → @@group] ${text}`);
      dbg(`user broadcast:`, JSON.stringify(text));
    }
  }

  /** --- internals --- */

  private ensureInbox(id: string) {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id)!;
  }

  private totalPending(): number {
    let n = 0;
    for (const q of this.inbox.values()) n += q.length;
    return n;
  }

  private nextPromptFor(id: string): string | null {
    const q = this.ensureInbox(id);
    if (q.length === 0) return null;
    // drain all pending lines for this turn
    const text = q.splice(0, q.length).join("\n");
    return text;
  }

  /** Route a text emitted by an agent. Returns true if it addressed @@user. */
  private async route(from: string, text: string): Promise<boolean> {
    const parts = TagParser.parse(text || "");
    const saw = { user: false, agent: false, group: false, file: false };
    for (const t of parts) {
      if (t.kind === "user") saw.user = true;
      if (t.kind === "agent") saw.agent = true;
      if (t.kind === "group") saw.group = true;
      if (t.kind === "file") saw.file = true;
    }
    dbg(`route parts from ${from}:`, JSON.stringify(parts.map(p => p.kind)));

    const router = makeRouter({
      onAgent: async (_from, to, content) => {
        this.ensureInbox(to).push(content);
        Logger.debug(`${from} → @@${to}: ${content}`);
        dbg(`${from} -> @@${to}:`, JSON.stringify(content));
      },
      onGroup: async (_from, content) => {
        for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(content);
        Logger.debug(`${from} → @@group: ${content}`);
        dbg(`${from} -> @@group:`, JSON.stringify(content));
      },
      onUser: async (_from, content) => {
        this.lastUserDMTarget = from;
        Logger.debug(`${from} → @@user: ${content}`);
        dbg(`${from} -> @@user:`, JSON.stringify(content));
      },
      onFile: async (_from, name, content) => {
        const { cleaned } = extractCodeGuards(content);
        const cmd = `${content}\n***** Write to file? [y/N] ${name}\n`;
        // Temporarily ensure cooked mode so input isn't stolen by hotkey handler
        const wasRaw = (process.stdin as any)?.isRaw;
        try {
          if (wasRaw) { try { process.stdin.setRawMode(false); } catch {} }
          await ExecutionGate.gate(cmd);
          const res = await FileWriter.write(name, cleaned);
          Logger.info(`wrote ${res.path} (${res.bytes} bytes)`);
          dbg(`file write OK: ${name}, bytes=${res.bytes}`);
        } catch (err: any) {
          Logger.error(`file write denied or failed (${name}): ${err?.message || String(err)}`);
          dbg(`file write ERR: ${name}`, err?.message || err);
        } finally {
          if (wasRaw) { try { process.stdin.setRawMode(true); } catch {} }
        }
      }
    });

    await router(from, text);

    // If there were no tags, treat it as group text to others
    if (!saw.user && !saw.agent && !saw.group && !saw.file) {
      for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(text);
      Logger.debug(`${from} → @@group (implicit): ${text}`);
      dbg(`${from} -> @@group (implicit):`, JSON.stringify(text));
    }
    return saw.user;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
