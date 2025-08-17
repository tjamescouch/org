import { sleep } from "../utils/sleep";

export interface MockReply {
  /** Final assistant text (may contain tags). */
  message: string;
  /** How many tools were consumed this turn (0..maxTools). */
  toolsUsed: number;
}

export class MockModel {
  private name: string;
  private turn = 0;

  constructor(name: string) {
    this.name = name;
  }

  async respond(prompt: string, maxTools: number, peers: string[]): Promise<MockReply> { 
    await sleep(1000);
    // First two turns: pretend to "use tools" up to the budget
    if (maxTools > 0 && this.turn < 2) {
      this.turn++;
      const iso = new Date().toISOString();
      // Show it's grouped (and to keep routers exercised)
      return { message: `@group ${this.name} ran a tool: ${iso}`, toolsUsed: 1 };
    }

    // After tools are done, emit a few variations that include tags.
    this.turn++;

    const peer = peers.find((p) => p !== this.name) || "group";
    const patterns = [
      `@${peer} did you see the update?`,
      `#notes-${this.name}.txt Here are some notes for the team.\nLine 2.`,
      `@group All good on my side.`,
    ];
    const msg = patterns[this.turn % patterns.length];

    return { message: msg, toolsUsed: 0 };
  }
}
