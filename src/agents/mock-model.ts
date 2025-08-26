import { ChatMessage } from "../drivers/types";
import { sleep } from "../utils/sleep";
import { Agent, AgentReply } from "./agent";

export class MockModel extends Agent {
  private turn = 0;

  constructor(private readonly name: string) {
    super("mock");
  }

  async respond(messages: ChatMessage[], maxTools: number, _peers: string[], abortCallback: () => boolean): Promise<AgentReply[]> { 
    await sleep(1000);
    const writePem = messages.some(m => m.content.match(/\.pem/i));
    if (writePem) {
      return [{ message: 'sh {"cmd":"echo secret > test.pem"}', toolsUsed: 1 }, { message: '@@user your turn', toolsUsed: 0 }];
    }

    console.log("MESSAGES", messages)

    // First two turns: pretend to "use tools" up to the budget
    if (maxTools > 0 && this.turn < 2) {
      this.turn++;
      const iso = new Date().toISOString();
      // Show it's grouped (and to keep routers exercised)
      return [{ message: `@@group ${this.name} ran a tool: ${iso}`, toolsUsed: 1 }];
    }

    // After tools are done, emit a few variations that include tags.
    this.turn++;

    const peer = messages.find((m) => m.from !== this.name) || "group";
    const patterns = [
      `@@${peer} did you see the update?`,
      `##notes-${this.name}.txt Here are some notes for the team.\nLine 2.`,
      `@@group All good on my side.`,
      `@@user Done.`,
    ];
    const msg = patterns[this.turn % patterns.length];

    return [{ message: msg, toolsUsed: 0 }];
  }
}
