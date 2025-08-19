// src/llm-agent.ts
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import type { ChatDriver, ChatMessage } from "../drivers/types";
import { SH_TOOL_DEF, runSh } from "../tools/sh";
import { C, Logger } from "../logger";
import { AdvancedMemory, AgentMemory } from "../memory";
import { GuardRail, StandardGuardRail, GuardRouteKind } from "../guardrail";
const DBG = /^(1|true|yes|debug)$/i.test(String(process.env.DEBUG ?? ""));
const dbg = (...a: any[]) => { if (DBG) Logger.info("[DBG][agent]", ...a); };

export interface AgentReply {
  message: string;   // assistant text
  toolsUsed: number; // number of tool calls consumed this hop
}

/**
 * LlmAgent
 * - Keeps conversation state via pluggable memory (SummaryMemory with hysteresis).
 * - Executes the "sh" tool (gated elsewhere) and feeds results back as role:"tool".
 * - Other agents & the user are presented as role:"user".
 * - Exposes a polymorphic guard rail (loop detection, tool misuse escalation).
 */
export class LlmAgent {
  private readonly id: string;
  private readonly driver: ChatDriver;
  private readonly model: string;
  private readonly tools = [SH_TOOL_DEF];

  // Memory replaces the old raw history array.
  private readonly memory: AgentMemory;
  private readonly systemPrompt: string;

  // Guard rails (loop / quality signals), per-agent, pluggable.
  private readonly guard: GuardRail;

  constructor(id: string, driver: ChatDriver, model: string, guard?: GuardRail) {
    this.id = id;
    this.driver = driver;
    this.model = model;
    this.guard = guard ?? new StandardGuardRail({ agentId: id });

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

If you need to run shell commands, call the sh tool. If you misuse a tool you will get an "Invalid response" message.
Commands are executed in a Debian VM.
Try to make decisions for yourself even if you're not completely sure that they are correct.
You have access to an actual Debian VM.
It has git, gcc and bun installed.

You have access to basic unix commands including pwd, cd, git, gcc, g++, python3, ls, cat, diff, grep, curl. 
To write to a file include a tag with the format ##file:<filename>. Follow the syntax exactly. i.e. lowercase, with no spaces.
This way you do not do a tool call and simply respond.

Example:
##file:index.ts
console.log("hello world");

Any output after the tag, and before another tag, will be redirected to the file, so avoid accidentally including other output or code fences etc. Just include the desired content of the file.
If multiple tags are present then multiple files will be written.
You have access to the apply_patch via the sh command to make small modifications to files.

Prefer the above tagging approach for writing files longer than a few paragraphs.
You may write to files with echo, apply_patch, patch, or the tagging approach.


You may direct message another agent using the following tag syntax: @@<username>

Example:
@@bob
I have implemented the architecture documents.

Prefer direct messages when the information is not important to other members of the group.
Responses with no tags are sent to the entire group.

Avoid accidentally writing to the end of the file when trying to switch back and prevent corrupting files.
Instead use @@group to expicitly switch back.
Examlple

##file:notes.txt
My awesome file
@@group
I wrote notes.txt check it out.

PLEASE use the file system.
PLEASE write files to disk rather than just chatting about them with the group.
PLEASE avoid overwriting existing files by accident. Check for and read existing files before writing to disk.

PLEASE run shell commands and test your work.

To communicate with the user use the user tag: @@user

DO NOT do the same thing over and over again (infinite loop)
If you get stuck reach out to the group for help.
Delegate where appropriate and avoid doing work that should be done by another agent.
Please actually use the tools provided. Do not simply hallucinate tool calls.
Do not make stuff up. Do not imagine tool invocation results. Avoid repeating old commands.
Verify and validate your work.
Verify and validate the work of your team members.
Messages will be of the format <username>: <message>.
DO NOT mimic the above format of messages within your response.

Use git and commit often.
DO NOT PUSH ANYTHING TO GITHUB.

Above all - DO THE THING. Don't just talk about it.
Speak only in your own voice as "${this.id}" in the first person.
Do not describe your intentions (e.g., "We need to respond as Bob").
Do not narrate plans or roles; provide the final answer only.
Do not quote other agents’ names as prefixes like "bob:" or "carol:".

Keep responses brief unless writing files.`;

    // Attach a hysteresis-based memory that summarizes overflow.
    this.memory = new AdvancedMemory({
      driver: this.driver,
      model: this.model,
      systemPrompt: this.systemPrompt,

      contextTokens: 30_000,          // model window
      reserveHeaderTokens: 1200,      // header/tool schema reserve
      reserveResponseTokens: 800,     // space for the next reply
      highRatio: 0.70,                // trigger summarization earlier than overflow
      lowRatio: 0.50,                 // target after summarization
      summaryRatio: 0.35,             // 35% of budget for the 3 summaries

      avgCharsPerToken: 4,            // char→token estimate
      keepRecentPerLane: 4,           // retain 4 most-recent per lane
      keepRecentTools: 3              // retain 3 most-recent tool outputs
    });
  }

  /**
   * Respond to a prompt.
   * - Add the user's text to memory.
   * - Let the model respond; if it asks for tools, execute (sh only) and loop.
   * - Stop after first assistant text with no more tool calls or when budget is hit.
   */
  async respond(prompt: string, maxTools: number, _peers: string[]): Promise<AgentReply> {
    dbg(`${this.id} start`, { promptChars: prompt.length, maxTools });

    // Initialize per-turn thresholds/counters in the guard rail.
    this.guard.beginTurn({ maxToolHops: Math.max(0, maxTools) });

    // 1) Add user content to memory
    await this.memory.add({ role: "user", content: prompt });

    let hop = 0;  
    let totalUsed = 0;  
    let finalText = "";
    let allReasoning: string | undefined;

    // 2) Main loop: let the model speak; if it requests tools, execute them; feed results.
    while (true) {
      Logger.info(C.green(`${this.id} ...`));
      const msgs = this.memory.messages();
      dbg(`${this.id} chat ->`, { hop: hop++, msgs: msgs.length });
      const t0 = Date.now();
      const out = await this.driver.chat(this.memory.messages(), {
        model: this.model,
        tools: this.tools,
      });
      dbg(`${this.id} chat <-`, { ms: Date.now() - t0, textChars: (out.text || "").length, toolCalls: out.toolCalls?.length || 0 });

      if ((!out.text || !out.text.trim()) && (!out.toolCalls || !out.toolCalls.length)) {
        dbg(`${this.id} empty-output`);
      }

      const assistantText = (out.text || "").trim();

      if ((out as any).reasoning && out.reasoning !== "undefined") allReasoning += `\n${out.reasoning}` || "";

      // Inform guard rail about this assistant turn (before routing)
      this.guard.noteAssistantTurn({ text: assistantText, toolCalls: (out.toolCalls || []).length });

      if (assistantText.length > 0) {
        finalText = assistantText;
      }

      const calls = out.toolCalls || [];
      if (!calls.length) {
        // No tools requested — capture assistant text in memory and yield.
        if (finalText) {
          dbg(`${this.id} add assistant`, { chars: finalText.length });
          await this.memory.add({ role: "assistant", content: finalText });
        }
        break;
      }

      // Execute tools (sh only), respecting remaining budget
      let forceEndTurn = false;

      for (const tc of calls) {
        if (forceEndTurn) Logger.warn("Turn forcibly ended.");

        if (totalUsed >= maxTools || forceEndTurn) break;

        const name = tc.function?.name || "";
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }

        if (name === "sh") {
          const rawCmd = String(args?.cmd ?? "");
          const cmd = rawCmd.replace(/\s+/g, " ").trim();

          if (!cmd) {
            const decision = this.guard.noteBadToolCall({
              name: "sh",
              reason: "missing-arg",
              missingArgs: ["cmd"],
            });
            if (decision?.nudge) {
              await this.memory.add({ role: "system", content: decision.nudge });
            }
            if (decision?.endTurn) {
              totalUsed = maxTools; // consume budget → end turn
              forceEndTurn = true;
              if (finalText) await this.memory.add({ role: "assistant", content: finalText });
              break;
            }

            // Synthesize a failed tool-output message back to memory (as before).
            const content = JSON.stringify({
              ok: false,
              stdout: "",
              stderr: "Execution failed: Command required.",
              exit_code: 1,
              cmd: "",
            });
            Logger.warn(`Execution failed: Command required.`);
            await this.memory.add({ role: "tool", content, tool_call_id: tc.id, name: "sh" } as ChatMessage);
            totalUsed++;
            continue;
          }

          // Normal execution
          dbg(`${this.id} tool ->`, { name, cmd: cmd.slice(0, 160) });
          const tSh = Date.now();
          const result = await runSh(cmd);
          dbg(`${this.id} tool <-`, { name, ms: Date.now() - tSh, exit: result.exit_code, outChars: result.stdout.length, errChars: result.stderr.length });

          // Let GuardRail see the signature to stop "same command" repetition
          const repeatDecision = this.guard.noteToolCall({
            name: "sh",
            argsSig: cmd, // argument signature = canonicalized cmd
            resSig: `${result.exit_code}|${(result.stdout || "").trim().slice(0, 240)}`,
            exitCode: result.exit_code,
          });
          if (repeatDecision?.nudge) {
            await this.memory.add({ role: "system", content: repeatDecision.nudge });
          }
          if (repeatDecision?.endTurn) {
            // Still record the tool output so the model can read it later.
            const contentJSON = JSON.stringify(result);
            await this.memory.add({ role: "tool", content: contentJSON, tool_call_id: tc.id, name: "sh" } as ChatMessage);

            totalUsed = maxTools;
            forceEndTurn = true;
            if (finalText) await this.memory.add({ role: "assistant", content: finalText });
            break;
          }

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
        if (finalText) {
          dbg(`${this.id} add assistant`, { chars: finalText.length });
          await this.memory.add({ role: "assistant", content: finalText });
        }
        break;
      }
      // Loop: the assistant will see tool outputs (role:"tool") now in memory.
    }

    if (allReasoning) Logger.info(C.cyan(`${allReasoning}`));
    Logger.info(C.bold(`${finalText}`));
    Logger.info(C.blue(`[${this.id}] wrote. [${totalUsed}] tools used.`));

    return { message: finalText, toolsUsed: totalUsed };
  }

  /** Polymorphic guard rail hook used by the scheduler for routing checks. */
  guardCheck(route: GuardRouteKind, content: string, peers: string[]) {
    return this.guard.guardCheck(route, content, peers);
  }

  /** Allow scheduler to ask this agent's guard rail for idle fallbacks. */
  guardOnIdle(state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }) {
    const anyGuard: any = this.guard as any;
    return typeof anyGuard.onIdle === 'function' ? anyGuard.onIdle(state) : null;
  }
}
