import { C, Logger } from "../logger";
import { R } from "../runtime/runtime";
import type { ChatDriver, ChatMessage, ChatToolCall } from "../drivers/types";
import { AgentMemory } from "../memory";
import { GuardRail } from "../guardrails/guardrail";
import { Agent, AgentCallbacks, AgentReply } from "./agent";
import { sanitizeContent } from "../utils/sanitize-content";
import { sanitizeAndRepairAssistantReply } from "../guard/sanitizer";
import { ToolExecutor } from "../executors/tool-executor";
import { StandardToolExecutor } from "../executors/standard-tool-executor";
import { createPDAStreamFilterHeuristic } from "../utils/filter-passes/llm-pda-stream-heuristic";
import { SH_TOOL_DEF } from "../tools/sh";
import { ChatResponse } from "../scheduler/types";
import { NoiseFilters } from "../scheduler/filters";
import { NormativeMemory } from "../memory/normative-memory";

function buildSystemPrompt(id: string): [string, string] {
  return [[
    `You are agent "${id}".`,
    "- DO NOT LIE",
    "- Do not pretend or hallucinate tool call results. Do not misrepresent the facts.",
    "",
    "TOOLS",
    "- sh(cmd): run a POSIX command. Args: {cmd:string}. Returns {ok, stdout, stderr, exit_code, cmd}.",
    "  • Use for builds/tests/git/etc. Check exit_code and stderr. Never invent outputs.",
    "",
    "FILES",
    "- Prefer tag-based writes for full files (no code fences):",
    "  ##file:path/to/file.ext",
    "  <entire file content>",
    "  (Everything until the next tag or end goes into that file.)",
    "- For small edits use apply_patch (via sh) or redirection. Read existing files before overwriting.",
    "",
    "MESSAGING",
    "- @@user to talk to the human.",
    "- All messages intended for the user must be prefixed with @@user. No other tags are permitted for direct user communication. The user does not see group chat.",
    "- @@<agent> to DM a peer.",
    "-  @@group to address everyone.",
    "- **Only insert a tag when a reply from that participant is required.** If I can keep working on the task without waiting for input, I should proceed silently.",
    "",
    "POLICY",
    "- Use git locally and commit when asked; NEVER push.",
    "- Do not call tools with empty/malformed args.",
    "",
    "ENVIRONMENT",
    "- Commands are run in an ephemeral docker container within the VM, and then synced with the VM after a batch of commands.",
    "- Standard Unix tools available: git, bun, gcc/g++, python3, curl, grep, diff, ls, cat, pwd, etc.",
    "",
    "AVOID DUPLICATION",
    "- Do not repeat the same output more than once unless the user explicitly asks for a repetition.  If a loop is detected (e.g., same block printed >1×), abort and ask for clarification.",
    "COMPLETION",
    '- Upon completion of your tasks PLEASE TAG the user (@@user). If you do not the conversation will simply continue.',
  ].join("\n"),
  [
    `- ${id}, You Work autonomously in the caller's current directory inside a Debian VM.`,
    "- Do the reasonable thing. Interpret things like a normal human would.",
    "- Do what the user asks.",
    "",
    "POLICY",
    "- Do the work, be concise. Validate results by running commands/tests.",
    "- Avoid loops: do not repeat the same failing action; change approach or ask @@user.",
    "",
    "OUTPUT STYLE",
    '- Provide a single, concise response to each user query. If multiple steps are required, enumerate them in one message.',
    `- Speak only in your own voice as "${id}" (first person).`,
    "- Do not prefix lines with other agents' names.",
    "- Keep chat replies brief unless you are writing files.",
    "- Only tag a participant when a response from them is needed; otherwise continue autonomously until completion.",

  ].join("\n")
  ]
}

/**
 * LlmAgent
 * - Keeps conversation state via pluggable memory (SummaryMemory with hysteresis).
 * - Executes the "sh" tool (gated elsewhere) and feeds results back as role:"tool".
 * - Other agents & the user are presented as role:"user".
 * - Exposes a polymorphic guard rail (loop detection, tool misuse escalation).
 */
export class LlmAgent extends Agent {
  private readonly driver: ChatDriver;
  private readonly model: string;
  private readonly tools = [SH_TOOL_DEF];

  // Memory replaces the old raw history array.
  private readonly memory: AgentMemory;
  private readonly baseSystemPrompt: string;
  private readonly defaultSystemPrompt: string;

  // New: polymorphic tool executor (pure refactor)
  private readonly toolExecutor: ToolExecutor;
  private streamFilter = createPDAStreamFilterHeuristic();

  constructor(id: string, driver: ChatDriver, model: string, guard?: GuardRail) {
    super(id, guard);

    this.driver = driver;
    this.model = model;

    // Compose system prompt: a short agent header + the shared default.
    [this.baseSystemPrompt, this.defaultSystemPrompt] = buildSystemPrompt(this.id);

    // Attach a hysteresis-based memory that summarizes overflow.
    this.memory = new NormativeMemory({
      driver: this.driver,
      model: this.model,
      baseSystemPrompt: this.baseSystemPrompt,
      defaultSystemPrompt: this.defaultSystemPrompt,

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

    // Default executor used polymorphically
    this.toolExecutor = new StandardToolExecutor();
  }

  async load(): Promise<void> {
    this.memory.load(this.id);
  }

  async save(): Promise<void> {
    this.memory.save(this.id);
  }

  async respond(messages: ChatMessage[], maxTools: number, filters: NoiseFilters, peers: Agent[], callbacks: AgentCallbacks): Promise<AgentReply[]> {
    const result: AgentReply[] = [];
    let newMessages: ChatMessage[] = [...messages].reverse();

    let remaining = maxTools;
    let hop = 0;
    let totalToolsUsed = 0;

    // Initialize per-turn thresholds/counters in the guard rail.
    this.guard.beginTurn({ maxToolHops: Math.max(0, maxTools) });

    Logger.debug(`ask ${this.id} (hop ${hop}) with budget=${remaining}`);

    for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
      let replies: ChatResponse[] = [];
      // ---- STREAM DEFERRAL (single seam to TTY controller) ----
      callbacks.onStreamStart?.();
      try {
        replies = await this.respondOnce(
          newMessages,
          Math.max(0, remaining),
          peers,
          callbacks.shouldAbort,
        );
      } finally {
        await callbacks?.onStreamEnd();
      }

      for (const { message, toolsUsed } of replies) {
        totalToolsUsed += toolsUsed;
        Logger.debug(
          `${this.id} replied toolsUsed=${toolsUsed} message=`,
          JSON.stringify(message)
        );

        const yieldToUser = await callbacks.onRoute(message, filters);
        if (await callbacks.onRouteCompleted(message, toolsUsed, yieldToUser)) {
          return result;
        }

        if (yieldToUser) {
          return result;
        }
      }

      if (totalToolsUsed > 0) {
        remaining = Math.max(0, remaining - totalToolsUsed);
        if (remaining <= 0) break;
      } else {
        break;
      }

      newMessages = [];
    }

    this.save();

    return result;
  }

  /**
   * Respond to a prompt.
   * - Add the user's text to memory.
   * - Let the model respond; if it asks for tools, execute (sh only) and loop.
   * - Stop after first assistant text with no more tool calls or when budget is hit.
   */
  async respondOnce(messages: ChatMessage[], maxTools: number, _peers: Agent[], abortCallback: () => boolean): Promise<AgentReply[]> {
    Logger.debug(`${this.id} start`, { promptChars: prompt.length, maxTools });
    if (abortCallback?.()) {
      Logger.debug("Aborted turn");
      return [{ message: "Turn aborted.", toolsUsed: 0 }];
    }
    //const reverse = [...messages].reverse();
    for (const message of messages) {
      //await this.memory.addIfNotExists(message);
      await this.memory.add(message);
    }

    let hop = 0;

    Logger.info(C.green(`${this.id} is thinking.`));
    const msgs = this.memory.messages();
    Logger.debug(`${this.id} chat ->`, { hop: hop++, msgs: msgs.length });
    const t0 = Date.now();
    Logger.debug('memory', this.memory.messages());
    const prevToolCallDeltas: Record<string, ChatToolCall[]> = {};

    const formatToolCallDelta = (tcd: ChatToolCall) => sanitizeContent(`${tcd.function.name} ${tcd.function.arguments}`);

    let streamState: "thinking" | "tool" | "content" = "thinking";

    const ptcds: string[] = [];

    const onToolCallDelta = (tcd: ChatToolCall) => {
      if (streamState !== "tool") {
        Logger.info("");
        streamState = "tool";
      }

      if (!prevToolCallDeltas[tcd.id ?? "0"]) prevToolCallDeltas[tcd.id ?? "0"] = [];

      const text: string = formatToolCallDelta(tcd);

      const prevText = ptcds[ptcds.length - 1] ?? "";
      let deltaText = text;

      if (text.startsWith(prevText)) {
        deltaText = text.slice(prevText.length);
      }

      ptcds.push(text);
      Logger.streamInfo(C.red(deltaText));
    }

    // --- Streaming filter: RAW when DEBUG=1/true/yes; FILTERED otherwise ---
    const dbg = (R.env.DEBUG ?? "").trim().toLowerCase();
    const dbg2 = (R.env.LOG_LEVEL || '').toUpperCase() === 'DEBUG';
    let debugStreaming = (dbg === "1") || (dbg === "true") || (dbg === "yes");
    if (dbg2) {
      debugStreaming = true;
    }

    const out = await this.driver.chat(this.memory.messages().map(m => this.formatMessage(m)), {
      model: this.model,
      tools: this.tools,
      onReasoningToken: t => {
        const hideCot = !R.env.ORG_HIDE_COT && (String(R.env.DEBUG || "").trim() !== "1");
        if (hideCot) {
          Logger.streamInfo(C.cyan('.'));
          return;
        }
        Logger.streamInfo(C.cyan(t))
      },
      onToken: t => {
        if (streamState !== "content") {
          Logger.info("");
          streamState = "content";
        }

        const cleaned = this.streamFilter.feed(t);
        if (cleaned) Logger.streamInfo(C.bold(cleaned));
      },
      onToolCallDelta
    });

    Logger.debug("this.driver.chat", out);

    const tail = this.streamFilter.flush();                            // then flush filter
    if (tail) Logger.streamInfo(C.bold(tail) + "\n");

    Logger.info('');
    Logger.debug(`${this.id} chat <-`, { ms: Date.now() - t0, textChars: (out.text || "").length, toolCalls: out.toolCalls?.length || 0 });

    if ((!out.text || !out.text.trim()) && (!out.toolCalls || !out.toolCalls.length)) {
      Logger.debug(`${this.id} empty-output`);
    }

    const finalText = ((out.text || "").trim());
    const allReasoning = out?.reasoning || "";

    // Inform guard rail about this assistant turn (before routing)
    this.guard.noteAssistantTurn({ text: finalText, toolCalls: (out.toolCalls || []).length });

    const calls = out.toolCalls || [];
    if (calls.length === 0) {
      // No tools requested — capture assistant text in memory and yield.
      if (finalText) {
        Logger.debug(`${this.id} add assistant`, { chars: finalText.length });
        await this.memory.add({ role: "assistant", content: finalText, from: "Me" });
      }
      Logger.info(C.blue(`\n[${this.id}] wrote. No tools used.`));
      return [{ message: finalText, toolsUsed: 0 }];
    }

    // Execute tools (sh only), respecting remaining budget
    let forceEndTurn = false;

    const {
      calls: sanitizedCalls,
      decision: firstDecision,
      forceRetry: _forceRetry,
    } = sanitizeAndRepairAssistantReply({ text: finalText, calls, toolsAllowed: this.tools.map(t => t.function.name), didRetry: false /* FIXME */ });

    if (firstDecision) {
      if (firstDecision?.nudge) {
        await this.memory.add({ role: "system", content: firstDecision.nudge, from: "System" });
      }
      if (firstDecision?.endTurn) {
        Logger.warn(`System prematurely ended turn.`);
        const totalUsed = maxTools; // consume budget → end turn
        forceEndTurn = true;
        if (finalText) await this.memory.add({ role: "system", content: finalText, from: "System" });

        return [{ message: finalText, toolsUsed: totalUsed }];
      }
    }

    // Delegate to executor (pure behavior)
    const execResult = await this.toolExecutor.execute({
      calls: sanitizedCalls,
      maxTools,
      abortCallback,
      guard: this.guard,
      memory: this.memory,
      finalText,
      agentId: this.id,
    });
    const toolsUsed = execResult.toolsUsed;
    forceEndTurn = execResult.forceEndTurn;

    if (toolsUsed >= maxTools) {
      if (finalText) {
        Logger.debug(`${this.id} add assistant memory`, { chars: finalText.length });
        await this.memory.add({ role: "assistant", content: `${allReasoning ? `${allReasoning} -> ` : ""}${finalText}`, from: "Me" });
      } else if (allReasoning) {
        Logger.debug(`${this.id} add assistant memory`, { chars: allReasoning.length });
        await this.memory.add({ role: "assistant", content: allReasoning, from: "Me" });
      }
    }

    Logger.info(C.blue(`\n[${this.id}] wrote. [${calls.length}] tools requested. [${toolsUsed}] tools used.`));

    return [{ message: finalText, toolsUsed: calls.length, reasoning: allReasoning }];
  }
}
