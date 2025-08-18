import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import type { ChatDriver, ChatMessage } from "../drivers/types";
import { SH_TOOL_DEF, runSh } from "../tools/sh";
import { C, Logger } from "../logger";
import { AgentMemory, ContextLimitedSummaryMemory } from "../memory";

export interface AgentReply {
  message: string;   // assistant text
  toolsUsed: number; // number of tool calls consumed this hop
}

/**
 * LlmAgent
 * - Keeps conversation state via pluggable memory (SummaryMemory with hysteresis).
 * - Executes the "sh" tool (gated elsewhere) and feeds results back as role:"tool".
 * - Other agents & the user are presented as role:"user".
 */
export class LlmAgent {
  private readonly id: string;
  private readonly driver: ChatDriver;
  private readonly model: string;
  private readonly tools = [SH_TOOL_DEF];

  // Memory replaces the old raw history array.
  private readonly memory: AgentMemory;
  private readonly systemPrompt: string;

  constructor(id: string, driver: ChatDriver, model: string) {
    this.id = id;
    this.driver = driver;
    this.model = model;

    // Compose system prompt: a short agent header + the shared default.
    this.systemPrompt =
      `You are agent "${id}". You can call tools and cooperate with other agents.
${DEFAULT_SYSTEM_PROMPT}
You can call tools. When you need to run a shell command on a POSIX system, use the "sh" tool:
- name: "sh"
- arguments: { "cmd": "<full command string>" }  (example: {"cmd":"ls -la"})
- The tool returns JSON: {"ok":boolean,"stdout":string,"stderr":string,"exit_code":number,"cmd":string}
- Prefer concise commands. Avoid infinite loops. Validate results from stdout/stderr.
- Do not fabricate tool output. Only rely on the returned JSON and previous context.
- Use git to version control your work but do not push.

Routing:
- If you want to send a direct message to another agent: prefix with "@@<agentName> ".
- To broadcast to everyone: prefix with "@@group ".
- To write a file, prefix with "##<filename>" followed by the file content.
- To yield content to the user write "@@user" followed by the file content.

Keep responses brief unless writing files.`;

    // Attach a hysteresis-based memory that summarizes overflow.
    this.memory = new ContextLimitedSummaryMemory({
      driver: this.driver,
      model: this.model,
      systemPrompt: this.systemPrompt,
      contextTokens: 8192, // or 32768, etc.
      // optional tuning:
      // reserveHeaderTokens: 1200,
      // reserveResponseTokens: 800,
      // avgMessageTokens: 220,
      // highRatio: 0.70,
      // lowRatio: 0.45,
    });
  }

  /**
   * Respond to a prompt.
   * - Add the user's text to memory.
   * - Let the model respond; if it asks for tools, execute (sh only) and loop.
   * - Stop after first assistant text with no more tool calls or when budget is hit.
   */
  async respond(prompt: string, maxTools: number, _peers: string[]): Promise<AgentReply> {
    await this.memory.add({ role: "user", content: prompt });

    let totalUsed = 0;
    let finalText = "";

    // At least one completion; allow tool-following up to maxTools
    for (let hop = 0; hop < Math.max(1, maxTools + 1); hop++) {
      Logger.info(C.green(`${this.id} ...`));

      const out = await this.driver.chat(this.memory.messages(), {
        model: this.model,
        tools: this.tools
      });

      const assistantText = (out.text || "").trim();
      if (assistantText.length > 0) {
        finalText = assistantText;
      }

      const calls = out.toolCalls || [];
      if (!calls.length) {
        // No tools requested — capture assistant text in memory and yield.
        if (finalText) {
          await this.memory.add({ role: "assistant", content: finalText });
        }
        break;
      }

      // Execute tools (sh only), respecting remaining budget
      for (const tc of calls) {
        if (totalUsed >= maxTools) break;

        const name = tc.function?.name || "";
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }

        if (name === "sh") {
          const cmd = String(args?.cmd || "").trim();
          if (cmd.length === 0) {
            Logger.warn(`${name} tool missing cmd`, { cmd, args });
            const content = JSON.stringify({ ok: false, stdout: "", stderr: "Execution failed: Command required.", exit_code: 1, cmd: "" });
            await this.memory.add({ role: "tool", content, tool_call_id: tc.id, name: "sh" } as ChatMessage);
            totalUsed++;
            continue;
          }
          const result = await runSh(cmd);
          const content = JSON.stringify(result);
          await this.memory.add({ role: "tool", content, tool_call_id: tc.id, name: "sh" } as ChatMessage);
          totalUsed++;
        } else {
          Logger.warn(`Unknown tool ${name} requested`);
          const content = JSON.stringify({ ok: false, stdout: "", stderr: `unknown tool: ${name}`, exit_code: 2, cmd: "" });
          await this.memory.add({ role: "tool", content, tool_call_id: tc.id, name } as ChatMessage);
          totalUsed++;
        }
      }

      if (totalUsed >= maxTools) {
        // Record whatever assistant text we have before yielding
        if (finalText) await this.memory.add({ role: "assistant", content: finalText });
        break;
      }
      // Loop: the assistant will see tool outputs (role:"tool") now in memory.
    }

    Logger.info(C.green(`${finalText}`));
    Logger.info(C.blue(`[${this.id}] wrote. [${totalUsed}] tools used.`));

    return { message: finalText, toolsUsed: totalUsed };
  }
}
