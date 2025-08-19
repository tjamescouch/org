import { Logger } from "./logger";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) Logger.info("[DBG][scheduler]", ...a); }

export interface AgentReply { message: string; toolsUsed: number; }
export interface Responder {
  id: string;
  respond(prompt: string, maxTools: number, peers: string[]): Promise<AgentReply>;
}

export class RoundRobinScheduler {
  private agents: Responder[];
  private maxTools: number;
  private inbox: Map<string, string[]> = new Map();
  private running = false;
  private paused = false;

  // prompts coming from router "@@user"
  private readonly userPromptFn: (fromAgent: string, content: string) => Promise<string | null>;

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
    let idlePasses = 0;

    // seed: if no agent has anything, prompt loop will ask user via onAskUser
    while (this.running) {
      if (this.paused) { await this.sleep(15); continue; }

      let progressed = false;

      for (const agent of this.agents) {
        const peers = this.agents.filter(a => a.id !== agent.id).map(a => a.id);
        const box = this.ensureInbox(agent.id);
        const next = box.shift();
        if (!next) continue;

        progressed = true;
        const reply = await agent.respond(next, this.maxTools, peers).catch((e) => {
          Logger.error(`[${agent.id}] respond failed: ${e}`);
          return { message: "", toolsUsed: 0 } as AgentReply;
        });

        if (reply.message && reply.message.trim()) {
          await this.routeAndDeliver(agent.id, reply.message.trim());
        }
      }

      if (!progressed) {
        idlePasses++;
        if (idlePasses >= 2) {
          // ask agents if they want user input implicitly
          // not blocking forever: short sleep and continue
          await this.sleep(50);
        } else {
          await this.sleep(10);
        }
      } else {
        idlePasses = 0;
      }
    }
  };

  stop() { this.running = false; }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** external injection from the console */
  handleUserInterjection(text: string) {
    const t = text.trim();
    if (!t) return;
    // broadcast to all agents
    for (const a of this.agents) this.ensureInbox(a.id).push(t);
  }

  private ensureInbox(id: string): string[] {
    let q = this.inbox.get(id);
    if (!q) { q = []; this.inbox.set(id, q); }
    return q;
  }

  /** ultra-simple tag router */
  private async routeAndDeliver(from: string, text: string): Promise<boolean> {
    // Collect @@user prompts
    let sawUser = false;
    const mentions = Array.from(text.matchAll(/@@([a-z0-9_-]+)/gi)).map(m => m[1].toLowerCase());
    const unique = Array.from(new Set(mentions));
    const deliveredIds = new Set<string>();

    if (unique.includes("user")) {
      sawUser = true;
      const promptToUser = text.replace(/@@user/gi, "").trim() || "(no message)";
      const userReply = await this.userPromptFn(from, promptToUser);
      if (userReply && userReply.trim()) {
        // deliver the user's reply to all agents
        for (const a of this.agents) {
          if (a.id !== from) this.ensureInbox(a.id).push(userReply);
        }
      }
    }

    // direct messages @@alice
    for (const id of unique) {
      if (id === "user" || id === "group") continue;
      const target = this.agents.find(a => a.id.toLowerCase() === id);
      if (target) {
        this.ensureInbox(target.id).push(text);
        deliveredIds.add(target.id);
      }
    }

    // group (or no tags): broadcast to others
    if (unique.length === 0 || unique.includes("group")) {
      for (const a of this.agents) if (a.id !== from && !deliveredIds.has(a.id)) this.ensureInbox(a.id).push(text);
    }

    return sawUser;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
