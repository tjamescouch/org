import { Agent } from './agent';

/** Focus: round-robin scheduling and simple group broadcast. */
export class RoundRobinScheduler {
  private agents: Agent[];
  private maxTools: number;
  private running = false;
  private paused = false;

  constructor(agents: Agent[], maxToolsPerTurn: number) {
    this.agents = agents;
    this.maxTools = maxToolsPerTurn;
  }

  /** Enqueue a user prompt to all agents. */
  broadcastUserPrompt(text: string) {
    for (const a of this.agents) a.receiveUserPrompt(text);
  }

  /** Called by agents when they "speak". Fan out to everyone else. */
  speak(fromId: string, text: string) {
    for (const a of this.agents) {
      if (a['id'] !== fromId) a.receiveUserPrompt(`${fromId}: ${text}`);
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  async start() {
    this.running = true;
    while (this.running) {
      if (this.paused) { await new Promise(r => setTimeout(r, 50)); continue; }
      let anyWork = false;
      for (const a of this.agents) {
        if (this.paused) break;
        if (a.hasWork()) {
          anyWork = true;
          await a.runTurn(this.maxTools);
        }
      }
      if (!anyWork) {
        // brief idle wait to avoid busy spin
        await new Promise(r => setTimeout(r, 50));
      }
    }
  }

  stop() { this.running = false; }
}
