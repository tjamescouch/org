import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import type { ChatDriver, ChatMessage } from "../drivers/types";
import { SH_TOOL_DEF, runSh } from "../tools/sh";
import { C, Logger } from "../logger";

export interface AgentReply {
  message: string;   // assistant text
  toolsUsed: number; // number of tool calls consumed this hop
}

/**
 * Very small stateful agent that adapts ChatDriver to the demo's respond() API.
 * - Maintains its own short history (system -> user -> assistant/tool ...)
 * - Executes the "sh" tool with safe gating and prints output in red
 * - Other agents' text is fed as role:"user" by the app — requirement satisfied
 */
export class LlmAgent {
  private readonly id: string;
  private readonly driver: ChatDriver;
  private readonly model: string;
  private history: ChatMessage[] = [];
  private readonly systemPrompt: string;
  private readonly tools = [SH_TOOL_DEF];

  constructor(id: string, driver: ChatDriver, model: string) {
    this.id = id;
    this.driver = driver;
    this.model = model;

    this.systemPrompt =
`You are agent "${id}".
    if (!(this as any).system || String((this as any).system).trim().length === 0) { (this as any).system = DEFAULT_SYSTEM_PROMPT; }
You can call tools. When you need to run a shell command on a POSIX system, use the "sh" tool:
- name: "sh"
- arguments: { "cmd": "<full command string>" }  (example: {"cmd":"ls -la"})
- The tool returns JSON: {"ok":boolean,"stdout":string,"stderr":string,"exit_code":number,"cmd":string}
- Prefer concise commands. Avoid infinite loops. Validate results from stdout/stderr.
- Do not fabricate tool output. Only rely on the returned JSON and previous context.

Routing:
- If you want to send a direct message to another agent: prefix with "@@<agentName> ".
- To broadcast to everyone: prefix with "@@group ".
- To write a file, prefix with "##<filename>" followed by the file content.
- To yield content to the user write "@@user" followed by the file content.

Keep responses brief unless writing files.`;

    this.history.push({ role: "system", content: this.systemPrompt });
  }

  /**
   * Respond to a prompt. Uses OpenAI function calling via driver:
   * - If model requests tool_calls, execute them (sh only) and feed results as role:"tool".
   * - Up to `maxTools` executions per respond() call.
   * - Yield after first assistant content that includes no tools.
   */
  async respond(prompt: string, maxTools: number, _peers: string[]): Promise<AgentReply> {
    // Add the user's prompt (in this agent view, other agents & users are "user")
    this.history.push({ role: "user", content: prompt });

    let totalUsed = 0;
    let finalText = "";

    // Permit at least one completion; follow tool calls up to maxTools
    for (let hop = 0; hop < Math.max(1, maxTools + 1); hop++) {
      Logger.info(C.green(`${this.id} ...`));
      const out = await this.driver.chat(this.history, { model: this.model, tools: this.tools });

      // If the assistant returned plain text, capture it (we still may see tool calls)
      if (out.text && out.text.trim().length > 0) {
        finalText = out.text.trim();
      }

      const calls = out.toolCalls || [];
      if (!calls.length) break; // No tools requested → yield after returning assistant text

      // Execute tools (sh only) — respect the remaining budget
      for (const tc of calls) {
        if (totalUsed >= maxTools) break;

        const name = tc.function?.name || "";
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }

        if (name === "sh") {
          const cmd = String(args?.cmd || "").trim();
          if (cmd.length === 0) {
            // Feed a minimal error back to the model as a tool result
            Logger.warn(`${name} tool missing cmd`);

            const content = JSON.stringify({ ok: false, stdout: "", stderr: "missing cmd", exit_code: 1, cmd: "" });
            this.history.push({ role: "tool", content, tool_call_id: tc.id, name: "sh" });
            totalUsed++;
            continue;
          }
          const result = await runSh(cmd);
          const content = JSON.stringify(result);
          this.history.push({ role: "tool", content, tool_call_id: tc.id, name: "sh" });
          totalUsed++;
        } else {
          // Unknown tool → return a structured error
          Logger.warn(`Unknown tool ${name} requested`);

          const content = JSON.stringify({ ok: false, stdout: "", stderr: `unknown tool: ${name}`, exit_code: 2, cmd: "" });
          this.history.push({ role: "tool", content, tool_call_id: tc.id, name });
          totalUsed++;
        }
      }

      // Loop back so the assistant can observe tool outputs and respond.
      if (totalUsed >= maxTools) break;
    }

    Logger.info(C.green(`${this.id} wrote:\n${finalText}\nwith [${totalUsed}] tools used.)`));

    return { message: finalText, toolsUsed: totalUsed };
  }
}
