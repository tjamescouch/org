/**
 * Very small "mock" model that:
 *  - For the first K turns uses "tools" (simulated) if allowed by the caller.
 *  - Otherwise emits simple text, sometimes with routing/file tags to exercise TagParser.
 *
 * You can replace this later with a real provider; the app only relies on
 * `respond(prompt, maxTools, peers)` shape, which returns a "message" string and
 * a `toolsUsed` count.
 */

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
    // First few turns: pretend to "use tools" up to the budget
    if (maxTools > 0 && this.turn < 2) {
      this.turn++;
      // Simulate a tool action (like `date`) but keep it inline and fast
      const iso = new Date().toISOString();
      return { message: `@group ${this.name} ran a tool: ${iso}`, toolsUsed: 1 };
    }

    // After tools are done, emit a few variations that include tags.
    this.turn++;

    // Rotate patterns to exercise TagParser & routing
    const peer = peers.find(p => p !== this.name) || "group";
    const patterns = [
      `@${peer} did you see the update?`,
      `#notes-${this.name}.txt Here are some notes for the team.\nLine 2.`,
      `@group All good on my side.`,
    ];
    const msg = patterns[this.turn % patterns.length];

    return { message: msg, toolsUsed: 0 };
  }
}
