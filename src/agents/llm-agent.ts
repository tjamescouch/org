import type { ChatDriver, ChatMessage } from "../drivers/types";

export interface AgentReply {
  message: string;   // assistant text
  toolsUsed: number; // number of tool calls consumed this hop
}

/**
 * Very small stateful agent that adapts ChatDriver to the demo's respond() API.
 * - Keeps its own short history (system -> user -> assistant ...)
 * - Reports how many tool calls were requested by the model; scheduler decrements budget.
 * - Does NOT execute tools; only counts requests and returns assistant text.
 */
export class LlmAgent {
  private readonly id: string;
  private readonly driver: ChatDriver;
  private readonly model: string;
  private history: ChatMessage[] = [];

  constructor(id: string, driver: ChatDriver, model: string) {
    this.id = id;
    this.driver = driver;
    this.model = model;
  }

  async respond(prompt: string, maxTools: number, _peers: string[]): Promise<AgentReply> {
    const userMsg: ChatMessage = { role: "user", content: prompt };
    this.history.push(userMsg);

    const out = await this.driver.chat(this.history, { model: this.model });
    // Count tool requests; do not execute (this demo only tracks budget)
    const requested = Array.isArray(out.toolCalls) ? out.toolCalls.length : 0;
    const toolsUsed = Math.min(requested, Math.max(0, maxTools));

    // Append assistant turn to history
    this.history.push({ role: "assistant", content: out.text || "" });

    return { message: out.text || "", toolsUsed };
  }
}
