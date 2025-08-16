// core/entity/agent-model.ts
// Full AgentModel with lock lease refresh via streaming onData callbacks.
// Keeps your original structure while wiring channelLock.touch() during tokens.

import { Model } from "./model";
import type { ChatRoom, RoomMessage } from "../chat-room";
import type { ChatMessage, ToolCall, ToolDef } from "../../types";

import { TagParser } from "../../tools/tools/tag-parser";
import { extractToolCallsFromText } from "../../tools/tools/tool-call-extractor";
import { chatOnce, summarizeOnce, type ChatResult, type Choice } from "../../transport/chat";
import { channelLock } from "../channel-lock";
import { AgentLog, Logger } from "../../ui/logger";
import { ExecutionGate } from "../../ui/key-input";

import {
  AbortRegistry,
  type AbortDetector,
  sanitizeAssistantText,
  MetaTagLeakDetector,
  AgentQuoteAbortDetector,
  ToolEchoFloodDetector,
  RepetitionAbortDetector,
  CrossTurnRepetitionDetector,
  MaxLengthAbortDetector,
  SpiralPhraseDetector,
} from "../abort-detectors";

import {
  VERBOSE,
  Reset, CyanTag, YellowTag, RedTag, GreenTag,
  BrightGreenTag, BrightYellowTag, BrightMagentaTag, BrightCyanTag, BrightWhiteTag
} from "../../constants";


// --- user pause/interjection flags ---
const isPaused = () => Boolean((globalThis as any).__PAUSE_INPUT);

const __userInterrupt = { ts: 0 };
export function markUserInterject() { __userInterrupt.ts = Date.now(); }

// --- logging shims ---
const SHOW_THINK = (process.env.SHOW_THINK === "1" || process.env.SHOW_THINK === "true");

// --- utilities ---
const truncate = (s: string, length: number): string => s.length <= length ? s : (s.slice(0, length) + "…");
const withTimeout = <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms))]) as any;

type Audience =
  | { kind: "group"; target: "*" }
  | { kind: "direct"; target: string }
  | { kind: "file"; target: string };

export class AgentModel extends Model {
  private __room?: ChatRoom;
  override get room(): ChatRoom | undefined { return this.__room; }
  override set room(r: ChatRoom | undefined) { this.__room = r; }
  public attachRoom(room: ChatRoom) { this.__room = room; }
  private roomOrThrow(): ChatRoom {
    if (!this.__room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    return this.__room;
  }

  private context: RoomMessage[] = [];
  private inbox: RoomMessage[] = [];
  private audience: Audience = { kind: "group", target: "*" };
  private fileToRedirectTo?: string;
  private system: string;
  private model: string;
  private _turnCounter = 0;
  private _lastSummarizeTurn = -1;
  private _lastSkipLog = 0;
  private _wakeTimer: any = null;
  private _leaseTouch?: () => void; // set while holding the channel lock

  private readonly shellTimeout = 60 * 60;
  private readonly maxShellReponseCharacters = 25_000;
  private readonly maxMessagesInContext = 27;
  private socText = "";
  private readonly maxSocChars = 50_000;
  private readonly contextWM = {
    high: Math.max(this.maxMessagesInContext + 6, Math.ceil(this.maxMessagesInContext * 1.5)),
    low: Math.max(Math.floor(this.maxMessagesInContext * 0.6), 6),
  };

  constructor(id: string, model: string) {
    super(id);
    this.model = model;
    this.system = `You are agent "${this.id}".
If you need to run shell commands, call the sh tool. If you misuse a tool you will get an "Invalid response" message.
Commands are executed in a Debian VM.
Try to make decisions for yourself even if you're not completely sure that they are correct.
You have access to an actual Debian VM.
It has git, gcc and bun installed.

You have access to basic unix commands including pwd, cd, git, gcc, g++, python3, ls, cat, diff, grep, curl. 
To write to a file include a tag with the format #file:<filename>. Follow the syntax exactly. i.e. lowercase, with no spaces.
This way you do not do a tool call and simply respond.

Example:
#file:index.ts
console.log("hello world");

Any output after the tag, and before another tag, will be redirected to the file, so avoid accidentally including other output or code fences etc. Just include the desired content of the file.
If multiple tags are present then multiple files will be written.
You have access to the apply_patch via the sh command to make small modifications to files.

Terminal responses are limited to ${this.maxShellReponseCharacters} characters. 

Prefer the above tagging approach for writing files longer than a few paragraphs.
You may write to files with echo, apply_patch, patch, or the tagging approach.


You may direct message another agent using the following tag syntax: @<username>

Example:
@bob
I have implemented the architecture documents.

Prefer direct messages when the information is not important to other members of the group.
Responses with no tags are sent to the entire group.

Avoid accidentally writing to the end of the file when trying to switch back to communicating with the group.
Instead use @group to expicitly switch back and prevent corrupting files.
Examlple

#file:notes.txt
My awesome file
@group
I wrote notes.txt check it out.

PLEASE use the file system.
PLEASE write files to disk rather than just chatting about them with the group.
PLEASE avoid overwriting existing files by accident. Check for and read existing files before writing to disk.

PLEASE run shell commands and test your work.
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

    Be concise.`;
  }

  // -------- TurnManager hooks --------
  public hasUnread(): boolean { return this.inbox.length > 0; }
  public enqueueFromRoom(msg: RoomMessage) { this._enqueue(msg); }
  public abortCurrentTurn(reason: string) {
    try { require("../../transport/chat").interruptChat(); } catch (e) { console.log(e) }
  }

  public async takeTurn(): Promise<boolean> {
    if (isPaused()) { Logger.debug(`[takeTurn] ${this.id} paused`); return false; }
    if (this.inbox.length === 0) { Logger.debug(`[takeTurn] ${this.id} empty inbox`); return false; }

    if (Date.now() - __userInterrupt.ts < 1500) return false;
    const tick: RoomMessage = {
      ts: new Date().toISOString(), role: "system", from: "TurnManager", content: "(tick)", read: false,
    } as any;
    await this.receiveMessage(tick);
    return true;
  }

  // -------- core flow --------
  async initialMessage(incoming: RoomMessage): Promise<void> {
    this._enqueue({ ...incoming, read: false });
    if (incoming.from !== this.id) return;
    const initial = typeof incoming.content === "string" ? incoming.content : "";
    Logger.info(`${CyanTag()} **** ${this.id} @ ${AgentLog.stamp()}${Reset()}
${initial}`);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {
    try {
      Logger.debug(`[recv] ${this.id} <- ${incoming.from} role=${incoming.role}`);
    } catch (e) { console.log(e) }

    const PAUSED = isPaused();
    const userJustInterjected = (Date.now() - __userInterrupt.ts) < 1500;
    if (PAUSED || userJustInterjected) {
      this._enqueue({ ...incoming, read: false });
      const now = Date.now();
      if (now - this._lastSkipLog > 900) {
        this._lastSkipLog = now;
        AgentLog.info(`${BrightYellowTag()}[skip] ${this.id}: user control; queued @ ${AgentLog.stamp()}${Reset()}`);
      }
      this._scheduleWake(1700);
      return;
    }

    this._enqueue({ ...incoming, read: false });

    // Acquire shared channel lock for the whole turn; refresh via streaming.
    const release = await channelLock.waitForLock(10_000, `agent:${this.id}`);
    this._leaseTouch = (release as any).touch || (() => channelLock.touch());
    if (isPaused() || (Date.now() - __userInterrupt.ts) < 1500) {
      try { await release(); } finally { this._leaseTouch = undefined; }
      const now = Date.now();
      if (now - this._lastSkipLog > 900) {
        this._lastSkipLog = now;
        Logger.info(`${BrightYellowTag()}[skip] ${this.id}: user control after lock; yielding${Reset()}`);
      }
      this._scheduleWake(1700);
      return;
    }

    try {
      const isUserIncoming = String(incoming.from || "").toLowerCase() == "user";
      const userFocusNudge: ChatMessage | null = isUserIncoming ? {
        role: "system", from: "System", read: true,
        content: "Last message is from end user. Respond directly and concisely. Avoid meta talk."
      } : null;

      this._turnCounter++;
      let summaryText = "";
      if (this.context.length > this.contextWM.high && (this._turnCounter - this._lastSummarizeTurn) >= 2) {
        const tail = this.context.slice(-20);
        const summarizerSystem: ChatMessage = { role: "system", from: "System", content: "Summarize recent progress in ≤120 words.", read: true };
        const releaseNet = await this._acquireTransport("summarize");
        try {
          try {
            summaryText = await withTimeout(
              summarizeOnce([summarizerSystem, ...tail, { role: "user", from: incoming.from, content: incoming.content, read: false }], { model: this.model }),
              180_000, "summary timeout"
            );
          } catch (err) { summaryText = ""; }
        } finally { await releaseNet(); }
        if (summaryText) this._lastSummarizeTurn = this._turnCounter;
      }

      const dynamicSystem: ChatMessage | null = summaryText
        ? { role: "system", from: "System", read: true, content: `Context summary:\n${summaryText}` }
        : null;

      const tail = this.context.slice(-20);
      const unread = this._drainUnread();
      const full: ChatMessage[] = [
        { role: "system", from: "System", content: this.system, read: false },
        ...(userFocusNudge ? [userFocusNudge] : []),
        ...(dynamicSystem ? [dynamicSystem] : []),
        ...tail,
        ...unread.map(m => ({ role: (m.role === "system" || m.from === this.id) ? "system" : "user", from: m.from, content: m.content, read: false } as ChatMessage)),
      ];

      const tools: ToolDef[] = [this._defShellTool()];
      Logger.debug?.(`[receive] ${this.id} unread=${unread.length} history=${full.length}`);

      const normalized = this._viewForSelf(full);
      let messages: ChatMessage[] = [];
      try {
        messages = await this.runWithTools(normalized, tools, (c) => this._execTool(c), 15);
      } catch (err: any) {
        Logger.error?.(`[receive] ${this.id} runWithTools error: ${err?.message || String(err)}`);
        messages = [];
      }

      for (const m of messages) {
        const mappedRole = (m.role === "tool") ? "tool" : (m.from === this.id ? "assistant" : "user");
        this.context.push({ ts: new Date().toISOString(), role: mappedRole as any, from: m.from, content: m.content, read: true });
      }

      const last = messages[messages.length - 1];
      if (last) {
        await this._deliver((last.content ?? (last as any).reasoning ?? ""));
      } else {
        Logger.error("lastMessage is undefined");
      }

      const assistantAggregate = messages
        .filter(m => m.role === "assistant" && m.from === this.id && typeof m.content === "string")
        .map(m => m.content as string).join("\n").slice(0, 8000);
      if (assistantAggregate.trim().length > 0) this._appendSoC(assistantAggregate);

      this.cleanContext();
    } finally {
      try { await release(); } finally { this._leaseTouch = undefined; }
    }
  }

  // --- tools/chat loop ---
  async runWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    execTool: (call: ToolCall) => Promise<ChatMessage>,
    maxHops: number
  ): Promise<ChatMessage[]> {
    const responses: ChatMessage[] = [];
    const MAX_TOOL_CALLS_PER_TURN = 6;
    let totalToolCallsThisTurn = 0;
    let wroteFileThisTurn = false;
    let breakerCooldown = 0;
    let breakerReason: string | null = null;

    let currentMessages: ChatMessage[] = [...messages];
    const recentToolSigs: string[] = [];
    const rememberSig = (s: string) => { recentToolSigs.push(s); if (recentToolSigs.length > 6) recentToolSigs.shift(); };
    const seenRecently = (s: string) => recentToolSigs.includes(s);

    const agents = Array.from(new Set(currentMessages.map(m => (m?.from || "").toLowerCase()).filter(Boolean)));
    const baseDetectors: AbortDetector[] = AbortRegistry.list.length ? AbortRegistry.list : [
      new MetaTagLeakDetector(),
      new AgentQuoteAbortDetector(agents),
      new ToolEchoFloodDetector(8),
      new RepetitionAbortDetector({ tailWords: 28, maxRepeats: 6, minWordsForNovelty: 320, minNoveltyRatio: 0.02 }),
      new CrossTurnRepetitionDetector({ tailWords: 28, minChars: 360, minNoveltyRatio: 0.03, sampleSocChars: 50000 }),
      new MaxLengthAbortDetector(30000),
      new SpiralPhraseDetector(),
    ];

    const invokeChat = async (tempBump = 0) => {
      const toolsForHop = (breakerCooldown > 0) ? [] : tools;
      const toolChoiceForHop = (breakerCooldown > 0) ? ("none" as const) : ("auto" as const);
      const remainingCalls = Math.max(0, MAX_TOOL_CALLS_PER_TURN - totalToolCallsThisTurn);
      const nudge: ChatMessage = {
        role: "system", from: "System", read: true,
        content: `Tools remaining: ${remainingCalls}. Prefer #file:<path> for code.`
      };
      const normalized = this._viewForSelf(currentMessages);
      const messagesForHop: ChatMessage[] = [...normalized, nudge];

      const chatOpts: any = {
        tools: toolsForHop, tool_choice: toolChoiceForHop, num_ctx: 128000,
        abortDetectors: baseDetectors, model: this.model, soc: this.socText,
        temperature: 1 + tempBump,
        onData: (data: string) => {
          try {
            //console.log(JSON.stringify(data, null, 2));
            //Logger.streamInfo(data);
            this._leaseTouch?.();
          } catch (e) { console.log("error", e) }
        }, // <-- refresh lease each streamed chunk
      };

      Logger.debug(`[run] ${this.id} chatOnce …`);

      const msg = await withTimeout(
        chatOnce(this.id, messagesForHop, chatOpts),
        600_000, "chatOnce hop timeout"
      ).catch((e) => { Logger.error?.(`[run] chatOnce error: ${String(e)}`); return null; });

      return msg;
    };

    for (let hop = 0; hop < maxHops; hop++) {
      if (Date.now() - __userInterrupt.ts < 1500) {
        responses.push({ role: "system", from: "System", read: true, content: "Turn interrupted by user." });
        break;
      }

      let msg: any = await invokeChat(0);
      if (msg && typeof msg.content === "string" && msg.content.length) {
        const san = sanitizeAssistantText(msg.content);
        if (san.aborted) msg.content = san.text;
      }

      await new Promise(r => setTimeout(r, 25));

      if (!msg || ((!msg.content || String(msg.content).trim().length === 0) && (!msg.tool_calls || msg.tool_calls.length === 0))) {
        msg = await invokeChat(0.3).catch(() => msg);
      }
      if (msg && typeof msg.content === "string" && msg.content.length) {
        const san2 = sanitizeAssistantText(msg.content);
        if (san2.aborted) msg.content = san2.text;
      }
      if (!msg) msg = { role: "assistant", content: "" };

      // parse tags, aggregate tool_calls (declared + extracted)
      const { clean: response, tags } = TagParser.parse(msg.content || "");
      const extractedAll = extractToolCallsFromText(msg.content ?? "").tool_calls || [];
      const tool_calls = [...(msg.tool_calls ?? []), ...extractedAll];

      if (!tool_calls || tool_calls.length === 0) {
        if (SHOW_THINK && (msg as any).reasoning) {
          responses.push({ role: "assistant", from: this.id, content: `${BrightMagentaTag()}${(msg as any).reasoning}${Reset()}\n`, read: true } as any);
        }
        const trimmed = String(response ?? "").trim() || "Acknowledged.";
        responses.push({ role: "assistant", from: this.id, content: trimmed, read: true });

        if (tags.length > 0) {
          const saved = { ...this.audience } as any;
          for (const t of tags) {
            if (t.kind === "file") {
              this.fileToRedirectTo = t.value;
              const status = await this._deliver(t.content ?? "");
              if (status) responses.push(status);
              wroteFileThisTurn = true;
            } else if (t.kind === "agent") {
              this.audience = { kind: "direct", target: t.value } as any;
              const delivered = await this._deliver(t.content ?? "");
              if (delivered) responses.push(delivered);
              this.audience = { ...saved } as any;
            }
          }
        }
        breakerCooldown = 0; breakerReason = null;
        break;
      }

      let lastSig: string | undefined;
      for (const call of tool_calls) {
        if (totalToolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN) {
          breakerCooldown = 1; breakerReason = `cap ${MAX_TOOL_CALLS_PER_TURN}`;
          responses.push({ role: "system", from: "System", read: true, content: `Tool cap reached. Next: NO TOOLS.` });
          break;
        }
        let rawArgs = typeof call?.function?.arguments === "object" ? JSON.stringify(call?.function?.arguments) : String(call?.function?.arguments ?? "");
        if ((call?.function?.name || "") === "sh") {
          try { const parsed = JSON.parse(rawArgs); if (parsed && typeof parsed.cmd === "string") rawArgs = JSON.stringify({ ...parsed, cmd: parsed.cmd.replace(/\s+/g, " ").trim() }); } catch (e) { /* intentionally blank */ }
        }
        const sig = `${call?.function?.name}|${rawArgs}`;
        if (lastSig && sig === lastSig) {
          responses.push({ role: "assistant", from: this.id, read: true, content: `Aborted duplicate tool call: ${call?.function?.name}` });
          breakerCooldown = 1; breakerReason = `duplicate ${call?.function?.name}`;
          responses.push({ role: "system", from: "System", read: true, content: `Loop detected. Next: NO TOOLS.` });
          break;
        }
        if (seenRecently(sig)) {
          responses.push({ role: "assistant", from: this.id, read: true, content: `Skipping repeat tool call: ${call?.function?.name}` });
          breakerCooldown = 1; breakerReason = `repeat ${call?.function?.name}`;
          responses.push({ role: "system", from: "System", read: true, content: `We already ran this. Next: NO TOOLS.` });
          continue;
        }
        lastSig = sig; rememberSig(sig);

        const toolMsg = await execTool(call);
        responses.push(toolMsg);
        totalToolCallsThisTurn++;
      }

      if (tags.length > 0) {
        const saved = { ...this.audience } as any;
        for (const t of tags) {
          if (t.kind === "file") {
            this.fileToRedirectTo = t.value;
            const status = await this._deliver(t.content ?? "");
            if (status) responses.push(status);
            wroteFileThisTurn = true;
          } else if (t.kind === "agent") {
            this.audience = { kind: "direct", target: t.value } as any;
            const delivered = await this._deliver(t.content ?? "");
            if (delivered) responses.push(delivered);
            this.audience = { ...saved } as any;
          }
        }
      }

      const nextMsgs: ChatMessage[] = [...messages, ...responses];
      const remaining = Math.max(0, MAX_TOOL_CALLS_PER_TURN - totalToolCallsThisTurn);
      if (remaining <= 2 && !wroteFileThisTurn) {
        nextMsgs.push({ role: "system", from: "System", read: true, content: `Tool calls are nearly exhausted (${remaining}). Prefer #file writes.` });
      }

      if (breakerCooldown > 0) {
        nextMsgs.push({ role: "system", from: "System", read: true, content: `Tool loop breaker engaged${breakerReason ? ` (${breakerReason})` : ""}. Next: NO TOOLS.` });
        breakerCooldown = Math.max(0, breakerCooldown - 1);
      }
      currentMessages = nextMsgs;
    }

    if (responses.length === 0) {
      responses.push({ role: "assistant", from: this.id, content: "(no content)", read: true });
    }
    try {
      const parts: string[] = [];
      for (const m of responses) if (m.role === "assistant" || m.role === "tool") parts.push(`${m.role}:${String(m.content ?? "").slice(0, 60)}`);
      if (parts.length) Logger.debug?.(`[outputs] ${this.id} ${parts.join(" | ")}`);
    } catch (e) { console.log(e) }
    return responses;
  }

  // ---- tools ----
  private _defShellTool(): ToolDef {
    return {
      type: "function",
      function: {
        name: "sh",
        description: "Run a POSIX shell command and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    };
  }

  private async _execTool(call: ToolCall): Promise<ChatMessage> {
    if (VERBOSE) Logger.warn("CALL " + JSON.stringify(call));

    const name: string = call?.function?.name ?? "unknown";
    try {
      const args = JSON.parse(call?.function?.arguments ?? '{"cmd": ""}') as { cmd: string };
      if (name === "sh" || name === "assistant") {
        const m = await this._runShell(name, { ...args, rawCmd: args.cmd });
        return { ...(m as any), tool_call_id: call.id, role: "tool", name, from: this.id, read: false } as any;
      }
      return { role: "tool", name: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, err: `unknown tool: ${name}` }), from: this.id, read: false };
    } catch (err) {
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: String(err) }), from: this.id, read: false };
    }
  }

  private async _runShell(functionName: string, { cmd, rawCmd }: { cmd: string, rawCmd?: string }): Promise<{ role: string, name: string, content: string }> {
    const timeout = Math.max(1, Number(this.shellTimeout));
    await ExecutionGate.gate(`Agent wants to run: sh\n${cmd ?? rawCmd} @ ${stamp()}`);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (timeout + 1) * 1000);

    try {
      const { stdout, stderr, code } = await runPortableShell(cmd, ac.signal);
      const result = { ok: code === 0, stdout, stderr, exit_code: code };
      const content = truncate(JSON.stringify(result), this.maxShellReponseCharacters);

      const CLAMP = 12000;
      const sOut = stdout.length > CLAMP ? stdout.slice(0, CLAMP) + "\n...[truncated]" : stdout;
      const sErr = stderr.length > CLAMP ? stderr.slice(0, CLAMP) + "\n...[truncated]" : stderr;

      appendDirect(`${YellowTag()}******* sh ${cmd ?? rawCmd} @ ${stamp()}${Reset()}
ok: ${result.ok}
exit_code: ${result.exit_code}
--- stdout ---
${BrightGreenTag()}${sOut}${Reset()}
--- stderr ---
${RedTag()}${sErr}${Reset()}
`);

      return { role: "tool", name: "sh", content };
    } catch (e: any) {
      const content = `sh -c ${cmd} -> ` + JSON.stringify({ ok: false, err: e?.message || String(e) });
      Logger.error(`sh ${cmd} failed: ${e?.message || String(e)}`);
      return { role: "tool", name: "sh", content };
    } finally { clearTimeout(timer); }
  }

  // ---- delivery/audience ----
  private async _deliver(msg: string): Promise<ChatMessage> {
    const kind: Audience["kind"] = this.fileToRedirectTo ? "file" : this.audience.kind;
    const target: string = this.fileToRedirectTo ? this.fileToRedirectTo : this.audience.target;
    let response: ChatMessage | undefined;

    try {
      switch (kind) {
        case "group": {
          const r: any = (this as any).__room || (this as any).room;
          if (r && typeof r.broadcast === "function") await r.broadcast(this.id, String(msg ?? ""));
          else Logger.error(`broadcast failed: Model "${this.id}" is not attached to a ChatRoom`);
          response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" } as any;
          break;
        }
        case "direct": {
          const r: any = (this as any).__room || (this as any).room;
          if (r && typeof r.broadcast === "function") await r.broadcast(this.id, String(msg ?? ""), target);
          else Logger.error(`sendTo failed: Model "${this.id}" is not attached to a ChatRoom`);
          response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" } as any;
          break;
        }
        case "file": {
          const p = (!target.startsWith("/") && !target.startsWith("./")) ? `./${target}` : target;
          await ExecutionGate.gate(`Agent wants to (over)write the file ${p} @ ${stamp()}`);
          const slash = p.lastIndexOf("/"); const dir = slash >= 0 ? p.slice(0, slash) : ".";
          if ((globalThis as any).Bun?.mkdir) {
            await (globalThis as any).Bun.mkdir(dir || ".", { recursive: true });
          } else {
            const fs = await import("fs"); await fs.promises.mkdir(dir || ".", { recursive: true });
          }
          const text = (msg.includes("\\n") && !msg.includes("\n"))
            ? msg.replace(/\\r\\n/g, "\r\n").replace(/\\n/g, "\n")
            : msg;
          if ((globalThis as any).Bun?.write) {
            await (globalThis as any).Bun.write(p, text + "\n", { create: true, append: false });
          } else {
            const fs = await import("fs"); await fs.promises.writeFile(p, text + "\n", { encoding: "utf-8" });
          }
          response = { ts: Date.now().toString(), from: this.id, role: "tool", read: true, content: `=> Written to file ${p}` } as any;
          Logger.info(`******* wrote file ${p} @ ${stamp()}`);
          break;
        }
      }
    } catch (e: any) {
      const p = (kind === "file") ? ((!target.startsWith("/") && !target.startsWith("./")) ? `./${target}` : target) : String(target);
      response = { ts: Date.now().toString(), from: this.id, role: "tool", read: true, content: `${JSON.stringify({ ok: false, err: String(e) })} Failed to write to file ${p}.` } as any;
      Logger.error(`file write failed: ${String(e)}`);
    } finally {
      if (this.fileToRedirectTo) this.audience = { kind: "group", target: "*" };
      this.fileToRedirectTo = undefined;
    }
    return response ?? { ts: Date.now().toString(), from: this.id, role: "system", read: true, content: "(deliver: no-op)" } as any;
  }

  // ---- queue / context ----
  private _enqueue(msg: RoomMessage): void {
    const m: RoomMessage = {
      ts: new Date().toISOString(),
      role: msg.role === "system" ? "system" : (msg.from === this.id ? "assistant" : "user"),
      from: msg.from, content: msg.content,
      read: Boolean(msg.read) === true ? true : false,
    } as any;
    if (m.from !== this.id && m.role !== "system") m.read = false;
    this.context.push(m);
    if (m.role !== "system" && m.from !== this.id) this.inbox.push({ ...m, read: false });
    this.cleanContext();
  }

  private _drainUnread(): RoomMessage[] {
    const batch = this.inbox.splice(0);
    if (batch.length) {
      const set = new Set(batch.map(b => b.ts + "|" + b.from + "|" + b.content));
      for (const m of this.context) {
        const key = m.ts + "|" + m.from + "|" + m.content;
        if (!m.read && set.has(key)) m.read = true;
      }
    }
    return batch;
  }

  private _scheduleWake(delayMs = 1700) {
    try { if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; } } catch (e) { console.log(e) }
    this._wakeTimer = setTimeout(() => {
      const nudge: RoomMessage = { ts: new Date().toISOString(), role: "system", from: "System", read: false, content: "(resume)" } as any;
      if (!(globalThis as any).__PAUSE_INPUT) void this.receiveMessage(nudge);
    }, Math.max(0, delayMs));
  }

  private _viewForSelf(history: ChatMessage[]): ChatMessage[] {
    const me = this.id;
    return history.map(m => {
      if (m.role === "system" || m.role === "tool") return m;
      if ((m as any).from === me) return { ...m, role: "assistant" as const };
      const tag = (m as any).from ? `[${(m as any).from}] ` : "";
      const c = String((m as any).content ?? "");
      const prefixed = c.startsWith("[") ? c : (tag + c);
      return { role: "user", from: (m as any).from ?? "User", content: prefixed, read: (m as any).read } as ChatMessage;
    });
  }

  private cleanContext() {
    const { high, low } = this.contextWM;
    if (this.context.length <= high) return;
    const target = Math.max(low - 1, 1);
    const needToDrop = Math.max(0, this.context.length - target);
    if (needToDrop <= 0) return;

    const head = this.context.slice(0, needToDrop);
    const tail = this.context.slice(needToDrop);

    let toolCount = 0; let lastCmd = ""; const filesWritten: string[] = [];
    for (const m of head) {
      const c = String(m.content || "");
      if (m.role === "tool") toolCount++;
      const cmdMatch = c.match(/\b(?:sh|bash)\b[^\n\r]*/i);
      if (cmdMatch) lastCmd = cmdMatch[0];
      const fileMatch = c.match(/#file:([^\s\n\r]+)/);
      if (fileMatch && fileMatch[1]) filesWritten.push(fileMatch[1]);
    }

    const headPreview = head.filter(m => m.role !== "system").slice(-4)
      .map(m => `${m.from}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 140)}`)
      .join("\n");

    const summaryLines: string[] = [];
    summaryLines.push(`[summary] Compressed ${head.length} earlier turns.`);
    if (toolCount) summaryLines.push(`tools_used=${toolCount}` + (lastCmd ? ` last_cmd="${lastCmd.slice(0, 120)}"` : ""));
    if (filesWritten.length) summaryLines.push(`files_written=${filesWritten.slice(-5).join(",")}`);
    if (headPreview) summaryLines.push(`recent_head:\n${headPreview}`);

    const summaryMsg = { ts: new Date().toISOString(), role: "system" as const, from: "System", content: summaryLines.join("\n"), read: true };
    this.context = [summaryMsg as any, ...tail];
    while (this.context.length > low + 1) this.context.shift();
  }

  private _appendSoC(s: string) {
    const clean = String(s || "").replace(/<think>.*?<\/think>/gs, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.socText = (this.socText + " " + clean);
    if (this.socText.length > this.maxSocChars) this.socText = this.socText.slice(-this.maxSocChars);
  }
}

// --- portable shell helper (Bun or Node child_process) ---
async function runPortableShell(cmd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number; }> {
  const g: any = globalThis as any;
  if (g.Bun?.spawn) {
    const proc = g.Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  // Node path
  const cp = await import("child_process");
  return await new Promise((resolve, reject) => {
    const p = cp.spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const onAbort = () => { try { p.kill("SIGTERM"); } catch (e) { console.log(e) } };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("error", (e: any) => { if (signal) signal.removeEventListener("abort", onAbort); reject(e); });
    p.on("close", (code: number) => { if (signal) signal.removeEventListener("abort", onAbort); resolve({ stdout: out, stderr: err, code: Number(code) }); });
  });
}

export default AgentModel;
