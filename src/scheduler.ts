import { TagParser } from "./utils/tag-parser";
import { makeRouter } from "./routing/route-with-tags";
import { Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";
import { FileWriter } from "./io/file-writer";
import { ExecutionGate } from "./tools/execution-gate";

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
    while (this.running) {
      if (this.paused) { await this.sleep(25); continue; }

      let didWork = false;

      for (const a of this.agents) {
        if (this.paused || !this.running) break;

        const basePrompt = this.nextPromptFor(a.id);
        if (!basePrompt) continue;

        let remaining = this.maxTools;
        // multiple hops if the model requests tools
        for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
          const peers = this.agents.map(x => x.id);
          const { message, toolsUsed } = await a.respond(basePrompt, Math.max(0, remaining), peers);

          const askedUser = await this.route(a.id, message);
          didWork = true;

          if (askedUser) {
            // wait for the user's reply then route it
            const userText = (await this.userPromptFn(a.id, message)) ?? "";
            if (userText.trim()) this.handleUserInterjection(userText.trim());
            break; // yield to next agent after talking to user
          }

          if (toolsUsed > 0) {
            remaining = Math.max(0, remaining - toolsUsed);
            if (remaining <= 0) break; // tool budget exhausted
            // loop again to let the model see tool output and respond
          } else {
            break; // no tools => yield
          }
        }
      }

      // avoid busy spin
      if (!didWork) await this.sleep(25);
    }
  };

  stop() { this.running = false; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** User pressed 'i' or otherwise typed — route to lastDM if available, else broadcast. */
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

  /** --- internals --- */

  private ensureInbox(id: string) {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id)!;
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
    const router = makeRouter({
      onAgent: async (_from, to, content) => {
        this.ensureInbox(to).push(content);
        Logger.debug(`${from} → @@${to}: ${content}`);
      },
      onGroup: async (_from, content) => {
        for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(content);
        Logger.debug(`${from} → @@group: ${content}`);
      },
      onUser: async (_from, content) => {
        this.lastUserDMTarget = from;
        Logger.debug(`${from} → @@user: ${content}`);
        // nothing else here; actual prompting handled by caller after this returns true
      },
      onFile: async (_from, name, content) => {
        const { cleaned } = extractCodeGuards(content);
        const cmd = `${content}\n***** Write to file? [y/N] ${name}\n`;
        try {
          await ExecutionGate.gate(cmd);
          const res = await FileWriter.write(name, cleaned);
          Logger.info(`wrote ${res.path} (${res.bytes} bytes)`);
        } catch (err: any) {
          Logger.error(`file write denied or failed (${name}): ${err?.message || String(err)}`);
        }
      }
    });

    const outcome = await router(from, text);
    // If there were no tags, treat it as group text to others
    if (!outcome.sawTags.user && !outcome.sawTags.agent && !outcome.sawTags.group && !outcome.sawTags.file) {
      for (const a of this.agents) if (a.id !== from) this.ensureInbox(a.id).push(text);
      Logger.debug(`${from} → @@group (implicit): ${text}`);
    }
    return outcome.sawTags.user;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
