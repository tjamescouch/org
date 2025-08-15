// --- Global pause helpers (for user input) ---
const isPaused = () => Boolean((globalThis as any).__PAUSE_INPUT);
const waitWhilePaused = async () => {
  while (isPaused()) { await new Promise(r => setTimeout(r, 50)); }
};
// --- Lightweight wrappers for unified logging ---
const __g: any = (globalThis as any) || {};
// --- Global transport backpressure (hard cap = 1 network call) ---
// Even if multiple agents/hops want to talk to the provider, we serialize
// all outbound /v1/chat requests to avoid LM Studio queue growth.
// NOTE: We deliberately ignore LM_MAX_CONCURRENCY here; cap is 1 by design.
// --- Global transport backpressure (strict single-flight + cooldown) ---
type ReleaseFn = () => Promise<void>;
const __transport = ((globalThis as any).__transport ||= {
  cap: 1,
  in: 0,
  q: [] as Array<() => void>,
  _gate: Promise.resolve(),       // serialize acquires to avoid races
  _coolUntil: 0,                  // millisecond timestamp for cooldown window
  inflight() { return this.in; },
  cooling() { return Date.now() < this._coolUntil; },

  async acquire(_label = ""): Promise<ReleaseFn> {
    // Serialize all acquires behind a microtask gate to prevent double-pass
    let handoff!: () => void;
    const wait = new Promise<void>(res => (handoff = res));
    const prev = this._gate;
    this._gate = (async () => { try { await prev; } finally { handoff(); } })();
    await wait;

    // Respect cooldown: callers wait here instead of piling requests in Studio
    while (this.cooling()) {
      await new Promise(r => setTimeout(r, 25));
    }

    if (this.in < this.cap) {
      this.in = 1;
      const released = false;
      return async () => {
        if (this.in === 1) this.in = 0;
        // small cooldown to defuse stampedes
        this._coolUntil = Date.now() + 150;
        const n = this.q.shift();
        n?.();
      };
    }

    await new Promise<void>(res => this.q.push(res));
    this.in = 1;
    return async () => {
      if (this.in === 1) this.in = 0;
      this._coolUntil = Date.now() + 150;
      const n = this.q.shift();
      n?.();
    };
  }
});
const logLine = (s: string) => { (console.log)(s); };
const logErr  = (s: string) => { ( console.error)(s); };
const appendDirect = (s: string) => { ( ((x: string)=>console.log(x)))(s.endsWith("\n")?s:(s+"\n")); };
const stamp = () => new Date().toLocaleTimeString();

const SHOW_THINK = (process.env.SHOW_THINK === "1" || process.env.SHOW_THINK === "true");

// --- Cooperative "user interrupt" flag (set from main on interject)
const __userInterrupt = { ts: 0 };
export function markUserInterject() { __userInterrupt.ts = Date.now(); }
const withTimeout = <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]) as any;
import { Model } from "./model";
import { channelLock } from "../channel-lock";
import { TagParser } from "../../tools/tools/tag-parser";
import { extractToolCallsFromText } from "../../tools/tools/tool-call-extractor";
import {
  VERBOSE,
  Reset,
  CyanTag,
  YellowTag,
  RedTag,
  GreenTag,
  BlueTag,
  MagentaTag,
  WhiteTag,
  BrightBlackTag,
  BrightRedTag,
  BrightGreenTag,
  BrightYellowTag,
  BrightBlueTag,
  BrightMagentaTag,
  BrightCyanTag,
  BrightWhiteTag,
} from '../../constants';

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
import type { ChatMessage, ToolCall, ToolDef } from "../../types";
import type { ChatRoom, RoomMessage } from "../chat-room";
import { chatOnce, summarizeOnce } from "../../transport/chat";
import { Logger } from "../../logger";

type Audience =
  | { kind: "group"; target: "*" } | { kind: "direct"; target: string }      // send only to a given model
  | { kind: "file"; target: string };         // write to a file on VM

const isEmpty = (maybeArray: any[]): boolean => {
  return (maybeArray ?? []).length === 0;
}

const truncate = (s: string, length: number): string => {
  if (s.length <= length) {
    return s;
  }
  return s.slice(0, length) + '...';
}

const makeToolCallId = (prefix: "call" | "tool"): string => {
  // Source characters for random fragments.  Using a separate variable
  // avoids TypeScript complaining about possibly undefined indices on
  // strings when indexing into them with Math.random().
  const alphabetArr = "abcdefghijklmnopqrstuvwxyz";
  // pick 2–3 random letters from the alphabet and join them
  const randPart = (): string => {
    const first = alphabetArr[Math.floor(Math.random() * alphabetArr.length)];
    const second = alphabetArr[Math.floor(Math.random() * alphabetArr.length)];
    return `${first}${second}`;
  };
  // join prefix with two random parts
  return `${prefix}_${randPart()}_${randPart()}`;
};


export class AgentModel extends Model {
  // --- ChatRoom attachment plumbing (allows ChatRoom.addModel to attach) ---
  private __room?: ChatRoom;

  /** Back-compat: expose as getter/setter so any existing `this.room` usage still works */
  override get room(): ChatRoom | undefined { return this.__room; }
  override set room(r: ChatRoom | undefined) { this.__room = r; }

  /** Called by ChatRoom.addModel(...) */
  public attachRoom(room: ChatRoom) { this.__room = room; }

  /** Helper for code paths that require a room reference */
  private roomOrThrow(): ChatRoom {
    if (!this.__room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    return this.__room;
  }
  /**
   * Normalize history so that for this agent, all other agents' messages are mapped to role:"user"
   * (while keeping system/tool intact).
   */
  private _viewForSelf(history: ChatMessage[]): ChatMessage[] {
    const me = this.id;
    return history.map(m => {
      if (m.role === 'system' || m.role === 'tool') return m;
      if ((m as any).from === me) {
        return { ...m, role: 'assistant' as const };
      } else {
        const tag = (m as any).from ? `[${(m as any).from}] ` : '';
        const c = String((m as any).content ?? '');
        const prefixed = c.startsWith('[') ? c : (tag + c);
        return { role: 'user', from: (m as any).from ?? 'User', content: prefixed, read: (m as any).read } as ChatMessage;
      }
    });
  }
  private context: RoomMessage[] = [];
  private inbox: RoomMessage[] = [];
  private readonly shellTimeout = 60 * 60;
  private audience: Audience = { kind: "group", target: "*" }; // default
  private fileToRedirectTo: string | undefined;
  private maxShellReponseCharacters: number = 25_000;
  private maxMessagesInContext = 27;
  private system: string;
  private model: string;
  private socText: string = "";
  private readonly maxSocChars = 50_000;
  // Hysteresis watermarks for context summarization
  private readonly contextWM = {
    // summarize only when we exceed HIGH…
    high: Math.max(this.maxMessagesInContext + 6, Math.ceil(this.maxMessagesInContext * 1.5)),
    // …and compress down to LOW (leave headroom for a 1-message summary)
    low: Math.max(Math.floor(this.maxMessagesInContext * 0.6), 6),
  };
  private _turnCounter = 0;
  private _lastSummarizeTurn = -1;
  private _wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSkipLog = 0;
  // Schedule a self-wake so the agent processes its unread inbox shortly after
  // the interjection window elapses. This prevents endless "skip" loops.
  private _scheduleWake(delayMs = 1700) {
    try { if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; } } catch {}
    this._wakeTimer = setTimeout(() => {
      // Re-enter via receiveMessage with a lightweight synthetic system nudge.
      const nudge: RoomMessage = {
        ts: new Date().toISOString(),
        role: 'system',
        from: 'System',
        read: false,
        content: '(resume)'
      } as any;
      // Only trigger if we're not currently paused.
      if (!(globalThis as any).__PAUSE_INPUT) {
        // Fire and forget — unread backlog will be drained inside.
        void this.receiveMessage(nudge);
      }
    }, Math.max(0, delayMs));
  }

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

    Be concise.
    `;
  }

  //
  // --- TurnManager integration methods ---
  // These are called by turn-manager.ts. They must not double-lock.
  //
  // Return whether this agent has unread messages queued (non-system, not from self).
  public hasUnread(): boolean {
    return this.inbox.length > 0;
  }

  // Called by ChatRoom to enqueue raw room messages (keeps unread state)
  public enqueueFromRoom(msg: RoomMessage) {
    this._enqueue(msg);
  }

  // Called by TurnManager watchdog to abort a long-running streamed turn.
  public abortCurrentTurn(reason: string) {
    try {
      // Best-effort: ask the streaming layer to abort
      require("./chat").interruptChat();
    } catch {}
  }

  // Called by the TurnManager scheduler to let the agent process its unread inbox.
  // We DO NOT take the channel lock here: receiveMessage() already acquires it.
  // We also avoid enqueuing more unread by using a synthetic system "tick" message.
  public async takeTurn(): Promise<boolean> {
    // Skip if paused (user control).  Log the reason for debugging.
    if (isPaused()) {
      Logger.debug(`[DEBUG takeTurn] agent=${this.id} skip due to paused`);
      return false;
    }
    // Skip if there are no unread messages.  Log the reason.
    if (this.inbox.length === 0) {
      Logger.debug(`[DEBUG takeTurn] agent=${this.id} skip due to empty inbox`);
      return false;
    }
    // Absolute single-flight: by default we defer our turn if any network call
    // is active.  However, for integration tests with multiple agents, this
    // behaviour can prevent the second agent from ever running when the first
    // agent holds the lock.  We relax this check by allowing scheduling
    // even when inflight() >= 1; the underlying transport gate will still
    // serialize network calls.  We keep the debug log to indicate when
    // inflight requests are active.
    try {
      const t = (globalThis as any).__transport;
      if (t && typeof t.inflight === "function" && t.inflight() >= 1) {
        Logger.debug(`[DEBUG takeTurn] agent=${this.id} detected transport busy (inflight=${t.inflight()}); continuing`);
        // Do not return here; allow runWithTools to proceed and queue network calls.
      }
    } catch {}

    // If the user just interjected, let the normal receive path handle it after the skip window.  Log the skip.
    const __userInterrupt = (globalThis as any).__userInterrupt || { ts: 0 };
    if (Date.now() - (__userInterrupt.ts || 0) < 1500) {
      Logger.debug(`[DEBUG takeTurn] agent=${this.id} skip due to userInterject`);
      return false;
    }

    const tick: RoomMessage = {
      ts: new Date().toISOString(),
      role: "system" as const,
      from: "TurnManager",
      content: "(tick)",
      read: false,
    };
    await this.receiveMessage(tick);
    return true;
  }
  //
  // --- end TurnManager integration methods ---

  /* ------------------------------------------------------------ */
  async initialMessage(incoming: RoomMessage): Promise<void> {
    await waitWhilePaused();
    this._enqueue({ ...incoming, read: false });
    // Only the sender of the kickoff should print/broadcast it once.
    if (incoming.from !== this.id) return;

    const initialContent: string = (incoming && typeof incoming.content === "string")
      ? incoming.content
      : "";

    logLine(`${CyanTag()} **** ${this.id} @ ${stamp()}${Reset()}\n${initialContent}`);
    // (broadcast removed)
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {
    // Log the incoming message for debugging.  Print the sender, recipient (this.id), role and a snippet of the content.
    try {
      const from = String(incoming.from || "");
      const contentSnippet = String(incoming.content || "").slice(0, 100);
      Logger.debug(`[DEBUG receive] agent=${this.id} from=${from} role=${incoming.role} content=${contentSnippet}`);
    } catch {
      // ignore logging errors
    }
    // --- Fast-path: if the user has taken control, skip this turn entirely
    const PAUSED = Boolean((globalThis as any).__PAUSE_INPUT);
    const userJustInterjected = (Date.now() - __userInterrupt.ts) < 1500;
    if (PAUSED || userJustInterjected) {
      // Record the message for history but do not generate a response now.
      this._enqueue({ ...incoming, read: false });

      // Throttle noisy skip logs to once per ~900ms per agent
      const now = Date.now();
      if (now - this._lastSkipLog > 900) {
        this._lastSkipLog = now;
        logLine(`${BrightYellowTag()}[skip] ${this.id}: user control active; skipping queued turn @ ${stamp()}${Reset()}`);
      }

      // Ensure we resume shortly after the interjection window expires
      this._scheduleWake(1700);
      return;
    }
    await waitWhilePaused();
    this._enqueue({ ...incoming, read: false });

    // Acquire the shared channel lock up-front so summarizeOnce and chatOnce do not overlap across agents
    const release = await channelLock.waitForLock(15 * 60 * 1000);
    // Guard again after acquiring the lock in case control changed while waiting
    if (Boolean((globalThis as any).__PAUSE_INPUT) || (Date.now() - __userInterrupt.ts) < 1500) {
      release();
      const now = Date.now();
      if (now - this._lastSkipLog > 900) {
        this._lastSkipLog = now;
        logLine(`${BrightYellowTag()}[skip] ${this.id}: user control after lock; yielding${Reset()}`);
      }
      this._scheduleWake(1700);
      return;
    }
    try {
      const isUserIncoming = String(incoming.from || "").toLowerCase() === "user";
      const userFocusNudge: ChatMessage | null = isUserIncoming ? {
        role: "system",
        from: "System",
        read: true,
        content:
          "The last message is from the end user. Respond directly to the user in 1–3 sentences. Avoid meta talk like 'we need to...' and do not include <think> sections. If a short action is required, state the next exact command or file to write. Do not call tools unless truly necessary."
      } : null;
      // Only summarize when context length exceeds HIGH watermark and not on every turn
      this._turnCounter++;
      let summaryText = "";
      if (this.context.length > this.contextWM.high && (this._turnCounter - this._lastSummarizeTurn) >= 2) {
        const tail = this.context.slice(-20);
        const summarizerSystem = {
          role: "system" as const,
          from: "System",
          content:
            "You are a succinct coordinator. Summarize the recent conversation as bullet points covering: current project goal, key constraints, files created/modified, tools/commands run and outcomes, and next concrete steps. Max 120 words. No code. No quotes.",
          read: true,
        };
        console.log(`${GreenTag()}Requesting summary${Reset()}`);
        {
          const releaseNet = await __transport.acquire("summarize");
          try {
            try {
              summaryText = await withTimeout(
                summarizeOnce([
                  summarizerSystem,
                  ...tail,
                  { role: "user", from: incoming.from, content: incoming.content, read: false }
                ], { model: this.model }),
                180_000,
                "summary timeout"
              );
            } catch (err) {
              console.error("*********** summary timeout");
              summaryText = "";
            }
          } finally {
            await releaseNet();
          }
        }
        if (summaryText) this._lastSummarizeTurn = this._turnCounter;
      }

      const dynamicSystem: ChatMessage | null = summaryText
        ? { role: "system", from: "System", content: `Context summary:\n${summaryText}` , read: true }
        : null;

      const tail = this.context.slice(-20);
      // Drain all unread messages for this agent; mark them as read inside context.
      const unreadBatch = this._drainUnread();
      const fullMessageHistory: ChatMessage[] = [
        { role: "system", from: "System", content: this.system, read: false },
        ...(userFocusNudge ? [userFocusNudge] : []),
        ...(dynamicSystem ? [dynamicSystem] : []),
        ...tail,
        ...unreadBatch.map(m => {
          const role = (m.role === 'system' || m.from === this.id) ? 'system' : 'user';
          return { role: role as "user" | "system", from: m.from, content: m.content, read: false } as ChatMessage;
        }),
      ];

      const tools: ToolDef[] = [
        this._defShellTool(),
      ];

      // Debug: log that we are about to invoke runWithTools and show how many
      // unread messages are being drained.  This helps identify whether
      // runWithTools is being executed for each agent.
      try {
        Logger.debug(
          `[DEBUG receiveMessage] agent=${this.id} unread=${unreadBatch.length} historyLength=${fullMessageHistory.length}`
        );
      } catch {}

      const normalizedHistory = this._viewForSelf(fullMessageHistory);
      let messages: ChatMessage[] = [];
      try {
        messages = await this.runWithTools(normalizedHistory, tools, (c) => this._execTool(c), 5);
      } catch (err) {
        // Log any errors that occur during runWithTools.  This helps diagnose
        // silent failures where an agent never produces output.
        try {
          Logger.error(
            `[DEBUG receiveMessage] agent=${this.id} runWithTools threw ${err instanceof Error ? err.message : String(err)}`
          );
        } catch {}
        messages = [];
      }
      for (const m of messages) {
        const mappedRole = (m.role === 'tool')
          ? 'tool'
          : (m.from === this.id ? 'assistant' : 'user');
        this.context.push({
          ts: new Date().toISOString(),
          role: mappedRole as any,
          from: m.from,
          content: m.content,
          read: true,
        });
      }
      const wroteThisTurn = messages.some(m => m.role === 'tool' && /=>\s*Written to file/i.test(String(m.content || '')));
      if (!wroteThisTurn && !(String(incoming.from || "").toLowerCase() === "user")) {
        this.context.push({
          ts: new Date().toISOString(),
          role: 'system',
          from: 'System',
          read: true,
          content: 'No files were written in the last turn. In your next reply: either write the required files using the #file:<relative/path> tag followed by the full file content, or provide a brief plain‑text summary and explicit next step. Avoid repeating directory listings or re-reading the same files.'
        });
      }

      const lastMessage = messages[messages.length - 1];
      if (lastMessage) {
        await this._deliver((lastMessage.content ?? (lastMessage.reasoning ?? '')));
      } else {
        logErr('lastMessage is undefined');
      }

      // Append this turn’s assistant text into the rolling SoC
      const assistantAggregate = messages
        .filter(m => m.role === 'assistant' && m.from === this.id && typeof m.content === 'string')
        .map(m => m.content as string)
        .join("\n")
        .slice(0, 8000);
      if (assistantAggregate.trim().length > 0) this._appendSoC(assistantAggregate);

      this.cleanContext();
    } finally {
      release();
    }
  }

  async runWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    execTool: (call: ToolCall) => Promise<ChatMessage>, // returns a {role:"tool", name, tool_call_id, content}
    maxHops: number
  ): Promise<ChatMessage[]> {
    // Log the start of a new runWithTools turn for debugging.  Include the agent id and a snippet of the last user message.
    try {
      const lastMsg = messages[messages.length - 1];
      const lastSnippet = lastMsg ? String(lastMsg.content || "").slice(0, 100) : "";
      Logger.debug(`[DEBUG runWithTools] agent=${this.id} starting turn. lastMsgFrom=${lastMsg?.from} lastMsgContent=${lastSnippet}`);
    } catch {
      // ignore logging errors
    }

    const responses: ChatMessage[] = [];
    const toolOptions = { tools, tool_choice: "auto" as const, num_ctx: 128000 };

    // --- Stuck breaker state ---
    let breakerCooldown = 0;            // when > 0, next hops run with tools disabled
    let breakerReason: string | null = null;
    let totalToolCallsThisTurn = 0;     // cap tool calls per run
    const MAX_TOOL_CALLS_PER_TURN = 6;
    let wroteFileThisTurn = false;        // did we write a file via #file tag this turn?

    // Start with the provided conversation
    let currentMessages: ChatMessage[] = [...messages];

    // Helper: treat pasted tool JSON as non-user-visible even on final hop
    const looksLikeToolJson = (s: string): boolean => {
      const t = (s || "").trim();
      if (!t) return false;
      if (/("stdout"|"stderr"|"exit_code"|"ok")/.test(t)) {
        if (t.startsWith("{") && t.endsWith("}")) {
          try {
            const o = JSON.parse(t);
            return o && typeof o === "object" && (
              Object.prototype.hasOwnProperty.call(o, "stdout") ||
              Object.prototype.hasOwnProperty.call(o, "stderr") ||
              Object.prototype.hasOwnProperty.call(o, "exit_code") ||
              Object.prototype.hasOwnProperty.call(o, "ok")
            );
          } catch {
            return true;
          }
        }
        return true;
      }
      return false;
    };

    // Track recent tool call signatures across hops to avoid loops
    const recentToolSigs: string[] = [];
    const rememberSig = (sig: string) => {
      recentToolSigs.push(sig);
      if (recentToolSigs.length > 6) recentToolSigs.shift();
    };
    const seenRecently = (sig: string) => recentToolSigs.includes(sig);

    for (let hop = 0; hop < maxHops; hop++) {
      // Debug: log the start of a hop.  This includes the hop index and
      // whether a user interject was detected.  Provides visibility into
      // multi-hop conversations.
      try {
        Logger.debug(
          `[DEBUG runWithTools] agent=${this.id} hop=${hop} currentMessages=${currentMessages.length}`
        );
      } catch {}
      // If the user just interjected, yield this turn so the new message is handled ASAP.
      if (Date.now() - __userInterrupt.ts < 1500) {
        responses.push({
          role: "system",
          from: "System",
          read: true,
          content: "Turn interrupted by user interjection. Yielding to process the user's message."
        });
        break;
      }
      // Determine tool availability for this hop
      const toolsForHop = (breakerCooldown > 0) ? [] : tools;
      const toolChoiceForHop = (breakerCooldown > 0) ? ("none" as const) : ("auto" as const);

      // Per-hop nudge: expose remaining tool calls and prefer #file writes for code
      const remainingCalls = Math.max(0, MAX_TOOL_CALLS_PER_TURN - totalToolCallsThisTurn);
      const nudgeMsg: ChatMessage = {
        role: "system",
        from: "System",
        read: true,
        content: `Tools remaining this turn: ${remainingCalls}. If you need to output code or long text, do not chat it—write it using the #file:<relative/path> tag followed by the file content. Avoid recursive listings like ls -R.`
      };
      const normalized = this._viewForSelf(currentMessages);
      const messagesForHop: ChatMessage[] = [...normalized, nudgeMsg];

      // Build per-hop abort detectors (model controls policy)
      const agents = Array.from(new Set(currentMessages
        .map(m => (m?.from || "").toLowerCase())
        .filter(Boolean)));

      const detectors: AbortDetector[] = AbortRegistry.list.length
        ? AbortRegistry.list
        : [
            new MetaTagLeakDetector(),
            new AgentQuoteAbortDetector(agents),
            new ToolEchoFloodDetector(8),
            new RepetitionAbortDetector({ tailWords: 28, maxRepeats: 6, minWordsForNovelty: 320, minNoveltyRatio: 0.02 }),
            new CrossTurnRepetitionDetector({ tailWords: 28, minChars: 360, minNoveltyRatio: 0.03, sampleSocChars: 50000 }),
            new MaxLengthAbortDetector(30000),
            new SpiralPhraseDetector(),
          ];

      let msg: any;
      const invokeChat = async (tempBump = 0) => {
        // Acquire the transport gate before issuing a chat request
        const releaseNet = await __transport.acquire("chat");
        try {
          // Assemble options for chatOnce.  Always include the agent's model and
          // other parameters.  If an upstream base URL override is present via
          // environment variables, propagate it to chatOnce so that the
          // transport layer will bypass the compiled-in fallback.  This
          // explicitly sets opts.baseUrl based on the current process.env
          // values rather than relying on module-level constants that may
          // capture stale environment variables.  See multi-agent integration
          // tests for context.
          const chatOpts: any = {
            tools: toolsForHop,
            tool_choice: toolChoiceForHop,
            num_ctx: 128000,
            abortDetectors: detectors,
            model: this.model,
            soc: this.socText,
            temperature: (typeof (undefined as any) === "undefined" ? 1 : 1) + tempBump,
          };
          const envBase = (process.env as any).OLLAMA_BASE_URL || (process.env as any).OAI_BASE;
          if (envBase) {
            chatOpts.baseUrl = envBase;
          }
          // Debug: log when we are about to invoke chatOnce with the
          // constructed options.  This helps detect whether multiple agents
          // attempt to call chatOnce and whether they are using the correct
          // base URL.
          try {
            Logger.debug(
              `[DEBUG runWithTools] agent=${this.id} calling chatOnce baseUrl=${chatOpts.baseUrl || 'default'} model=${chatOpts.model}`
            );
          } catch {}
          return await withTimeout(
            chatOnce(this.id, messagesForHop, chatOpts),
            600_000,
            "chatOnce hop timeout"
          ).catch(e => console.error(e));
        } finally {
          await releaseNet();
        }
      }
      msg = await invokeChat(0);
      // Belt-and-suspenders: trim any leaked control/meta tags from the assistant text.
      if (msg && typeof msg.content === "string" && msg.content.length) {
        const san = sanitizeAssistantText(msg.content);
        if (san.aborted) {
          try { (globalThis as any).__log?.(`[abort] ${this.id}: trimmed response due to ${san.reason}`, "yellow"); } catch {}
          msg.content = san.text;
        }
      }
      // If chat.ts flagged the response as censored, record a small notice in context
      if (msg && (msg as any).censored) {
        try {
          this.context.push({
            ts: new Date().toISOString(),
            role: "system" as const,
            from: "System",
            read: true,
            content: `[notice] part of ${this.id}'s streamed output was censored from chat logs (${(msg as any).censor_reason || "policy"}).`
          } as any);
        } catch {}
      }
      // Small pacing delay to avoid hammering the provider
      await new Promise(r => setTimeout(r, 25));
      // If an interject was signaled during this hop, don't keep retrying; yield now.
      if (Date.now() - __userInterrupt.ts < 1500 && (!msg || (!msg.content && !msg.tool_calls))) {
        responses.push({ role: "system", from: "System", read: true, content: "Yielding due to user interjection." });
        break;
      }
      const noTokens = !msg || (typeof msg.content === "string" ? msg.content.trim().length === 0 : true);
      const noTools = !msg?.tool_calls || (Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0);
      if (noTokens && noTools) {
        try { (Bun.stdout as any)?.write?.("."); } catch {}
        // Gentle retry with slightly wider sampling
        msg = await invokeChat(0.3).catch(() => msg);
      }
      // Also sanitize the retried response, if any
      if (msg && typeof msg.content === "string" && msg.content.length) {
        const san2 = sanitizeAssistantText(msg.content);
        if (san2.aborted) {
          try { (globalThis as any).__log?.(`[abort] ${this.id}: trimmed response (retry) due to ${san2.reason}`, "yellow"); } catch {}
          msg.content = san2.text;
        }
      }
      if (!msg) msg = { content: "Error" };

      // Guard: treat a second empty as a first-class outcome and avoid enqueuing an empty assistant turn
      {
        const stillEmpty = !msg?.content || String(msg.content).trim().length === 0;
        const stillNoTools = !msg?.tool_calls || (Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0);
        if (stillEmpty && stillNoTools) {
          // Do not advance with an empty turn; inject a short system nudge and back off tools for one hop
          breakerCooldown = 1; breakerReason = "empty-output";
          responses.push({ role: "system", from: "System", read: true, content: "Previous model turn produced no content. Next reply: NO TOOLS. Provide a concise textual update (2–3 sentences) or propose the next concrete step." });
          // Prepare for next loop iteration with currentMessages unchanged (plus nudge)
          currentMessages = [...currentMessages, responses[responses.length - 1]];
          continue;
        }
      }

      // Parse tags from assistant content
      const { clean: response, tags } = TagParser.parse(msg.content || "");

      // Collect declared + embedded tool calls (forward ALL extracted)
      const extractedAll = extractToolCallsFromText(msg.content ?? "").tool_calls || [];
      const tool_calls = [
        ...(msg.tool_calls ?? []),
        ...extractedAll,
      ];

      // If there are *no* tool calls, this is a summary/final assistant message.
      if (!tool_calls || tool_calls.length === 0) {
        // Surface chain-of-thought when enabled.  Instead of wrapping
        // the reasoning in <think> tags, colour it using a bright
        // magenta tag to distinguish it from normal content.
        if (SHOW_THINK && (msg as any).reasoning) {
        responses.push({
          role: "assistant",
          from: this.id,
          // Append a newline after the coloured chain‑of‑thought so that the
          // subsequent answer appears on a new line.
          content: `${BrightMagentaTag()}${(msg as any).reasoning}${Reset()}\n`,
          reasoning: (msg as any).reasoning,
          read: true,
        });
        }

        const trimmed = String(response ?? "").trim();
        let finalText = trimmed;
        if (!finalText) {
          // If the user just spoke, provide a minimal acknowledgment to keep the loop moving.
          finalText = "Got it — acknowledged. I’ll proceed based on your request.";
        }
        responses.push({
          role: "assistant",
          from: this.id,
          content: finalText,
          reasoning: (msg as any).reasoning,
          read: true,
        });

        // Handle tags on the *final* hop (file/direct). These produce tool/direct messages but
        // do not change the fact that we are done.
        if (tags.length > 0) {
          const savedAudience = { ...this.audience } as any;
          for (const t of tags) {
            if (t.kind === "file") {
              this.fileToRedirectTo = t.value;
              const statusMsg = await this._deliver(t.content ?? "");
              if (statusMsg) responses.push(statusMsg);
              wroteFileThisTurn = true;
            } else if (t.kind === "agent") {
              this.audience = { kind: "direct", target: t.value } as any;
              const delivered = await this._deliver(t.content ?? "");
              if (delivered) responses.push(delivered);
              this.audience = { ...savedAudience } as any;
            }
          }
        }

        breakerCooldown = 0; breakerReason = null;
        break; // finished; no more tools requested
      }

      // There *are* tool calls this hop: execute them and feed back results as role:"tool"
      let lastSig: string | undefined;
      for (const call of tool_calls) {
        if (totalToolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN) {
          breakerCooldown = 1; breakerReason = `cap ${MAX_TOOL_CALLS_PER_TURN} calls`;
          responses.push({ role: "system", from: "System", read: true, content: `Tool cap reached (${MAX_TOOL_CALLS_PER_TURN}). Next reply: NO TOOLS. Provide a concise textual update and next 1-2 steps.` });
          break;
        }
        // Build a normalized signature for this call
        let rawArgs = typeof call?.function?.arguments === "object" ? JSON.stringify(call?.function?.arguments) : String(call?.function?.arguments ?? "");
        // Light normalization for shell commands to collapse trivial variants
        if ((call?.function?.name || "") === "sh") {
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed.cmd === "string") {
              const norm = parsed.cmd.replace(/\s+/g, " ").trim();
              rawArgs = JSON.stringify({ ...parsed, cmd: norm });
            }
          } catch {}
        }
        const sig = `${call?.function?.name}|${rawArgs}`;

        // Debounce identical back-to-back tool calls (same hop)
        if (lastSig && sig === lastSig) {
          responses.push({ role: "assistant", from: this.id, read: true, content: `Aborted duplicate tool call (same-hop): ${call?.function?.name}` });
          breakerCooldown = 1; breakerReason = `duplicate ${call?.function?.name}`;
          responses.push({ role: "system", from: "System", read: true, content: `Loop detected (${call?.function?.name}). NEXT REPLY: **DO NOT CALL TOOLS**. Summarize what you just learned and propose the next concrete step in plain text.` });
          break;
        }
        // Debounce repeats seen in the last few hops
        if (seenRecently(sig)) {
          responses.push({ role: "assistant", from: this.id, read: true, content: `Skipping recently repeated tool call: ${call?.function?.name}` });
          breakerCooldown = 1; breakerReason = `repeat ${call?.function?.name}`;
          responses.push({ role: "system", from: "System", read: true, content: `We already ran ${call?.function?.name} with these arguments. NEXT REPLY: **NO TOOLS**. Give a short textual conclusion based on prior output and suggest the next step.` });
          continue;
        }
        lastSig = sig;
        rememberSig(sig);

        // Execute the tool and append its role:"tool" result so the next hop can see it
        const toolMsg = await execTool(call); // { role:"tool", name, tool_call_id, content, from, read }
        responses.push(toolMsg);
        totalToolCallsThisTurn++;
      }

      // Also handle tags **in the same hop** (don’t skip tools). This mirrors previous behavior.
      if (tags.length > 0) {
        const savedAudience = { ...this.audience } as any;
        for (const t of tags) {
          if (t.kind === "file") {
            this.fileToRedirectTo = t.value;
            const statusMsg = await this._deliver(t.content ?? "");
            if (statusMsg) responses.push(statusMsg);
            wroteFileThisTurn = true;
          } else if (t.kind === "agent") {
            this.audience = { kind: "direct", target: t.value } as any;
            const delivered = await this._deliver(t.content ?? "");
            if (delivered) responses.push(delivered);
            this.audience = { ...savedAudience } as any;
          }
        }
      }
      // Feed back everything produced so far (assistant messages + tool outputs)
      const nextMsgs: ChatMessage[] = [...messages, ...responses];

      // Late-hop nudge: if tool calls are nearly exhausted and no file was written, push for #file output
      const remainingAfterThisHop = Math.max(0, MAX_TOOL_CALLS_PER_TURN - totalToolCallsThisTurn);
      if (remainingAfterThisHop <= 2 && !wroteFileThisTurn) {
        nextMsgs.push({
          role: "system",
          from: "System",
          read: true,
          content: `Tool calls are nearly exhausted (${remainingAfterThisHop} left this turn). Stop calling tools unless strictly necessary. If you need to produce code, output it using the #file:<relative/path> tag followed by the file content.`
        });
      }

      if (breakerCooldown > 0) {
        nextMsgs.push({ role: "system", from: "System", read: true, content: `Tool loop breaker engaged${breakerReason ? ` (${breakerReason})` : ''}. For the next reply: **DO NOT CALL TOOLS**. Provide a concise summary of progress and the next 1–2 steps in plain text.` });
        breakerCooldown = Math.max(0, breakerCooldown - 1);
      }
      currentMessages = nextMsgs;
      // Loop back: the next chatOnce() sees the tool outputs via currentMessages
    }

    if (responses.length === 0) {
      responses.push({ role: "assistant", from: this.id, content: "(no content)", read: true });
    }

    // Debug: log a summary of the assistant outputs for this agent.  This helps
    // identify whether both agents are producing messages during integration
    // tests.  Only print if there is at least one assistant or tool message.
    try {
      const parts: string[] = [];
      for (const m of responses) {
        if (m.role === "assistant" || m.role === "tool") {
          const content = String(m.content ?? "").slice(0, 200);
          parts.push(`${m.role}:${content}`);
        }
      }
      if (parts.length) {
        Logger.debug(`[DEBUG agent-model] agent=${this.id} outputs=${parts.join(" | ")}`);
      }
    } catch {
      // ignore debug logging errors
    }
    breakerCooldown = 0; breakerReason = null;
    return responses;
  }


  /* ------------------------------------------------------------ */
  private _defShellTool(): ToolDef {
    return {
      type: "function",
      function: {
        name: "sh",
        description: "Run a POSIX shell command and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string" },
          },
          required: ["cmd"],
        },
      },
    };
  }

  /* ------------------------------------------------------------ */
  private async _execTool(call: ToolCall): Promise<ChatMessage> {
    if (VERBOSE) logErr("************** CALL " + JSON.stringify(call));

    const name: string = call?.function?.name ?? 'unknown';
    try {
      // Ensure arguments are parsed safely and type matches expected signature
      const args = JSON.parse(call?.function?.arguments ?? '{"cmd": ""}') as { cmd: string };
      if (name === "sh" || name === "assistant") {
        return { ...(await this._runShell(name, { ...args, rawCmd: args.cmd })), tool_call_id: call.id, role: "tool", name, from: this.id, read: false };
      }
      // unknown tool
      logErr(`Model attempted unknown tool: ${name}`);
      return { role: "tool", name: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, err: `unknown tool: ${name} - try using the sh tool` }), from: this.id, read: false };
    } catch (err) {
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: String(err) }), from: this.id, read: false };
    }
  }

  /* ---------- shell helper (Bun.spawn) ------------------------- */
  private async _runShell(functionName: string, { cmd, rawCmd }: { cmd: string, rawCmd?: string }): Promise<{role: string, name: string, content: string}> {

    const timeout = Math.max(1, Number(this.shellTimeout));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (timeout + 1) * 1000);

    try {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", signal: ac.signal });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // Machine-readable content for the model/conversation
      const result = { ok: code === 0, stdout, stderr, exit_code: code };
      const content = truncate(JSON.stringify(result), this.maxShellReponseCharacters);

      // Limit console printing to avoid overwhelming the terminal and slowing the VM
      const CLAMP = 12000; // chars per stream
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

      return {
        role: "tool",
        name: "sh",
        content,
      };
    } catch (e) {
      const content = `sh -c ${cmd} -> ` + JSON.stringify({ ok: false, err: e instanceof Error ? e.message : String(e) });
      logErr(`sh ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
      return {
        role: "tool",
        name: "sh",
        content
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- audience routing -------------------------------- */
  private _setAudience(modeStr: string) {
    logLine(`[mode] ${modeStr}`);
    if (modeStr === "group") {
      this.audience = { kind: "group", target: "*" };
    } else if (modeStr.startsWith("direct:")) {
      this.audience = { kind: "direct", target: modeStr.slice(7) };
    } else if (modeStr.startsWith("file:")) {
      this.audience = { kind: "file", target: modeStr.slice(5) };
    }
  }

  // inside AgentModel
  private async _deliver(msg: string): Promise<ChatMessage> {
    const kind: Audience["kind"] = this.fileToRedirectTo ? "file" : this.audience.kind;
    const target: string = this.fileToRedirectTo ? this.fileToRedirectTo : this.audience.target;
    let response: ChatMessage | undefined;
    try {
      switch (kind) {
        case "group": {
          const roomAny: any = (this as any).__room || (this as any).room;
          if (roomAny && typeof roomAny.broadcast === "function") {
            await roomAny.broadcast(this.id, String(msg ?? ""));
          } else {
            logErr(`file write failed: Error: Model "${this.id}" is not attached to a ChatRoom`);
          }
          response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" };
          break;
        }
        case "direct": {
          const roomAny: any = (this as any).__room || (this as any).room;
          if (roomAny && typeof roomAny.broadcast === "function") {
            await roomAny.broadcast(this.id, String(msg ?? ""), target);
          } else {
            logErr(`file write failed: Error: Model "${this.id}" is not attached to a ChatRoom`);
          }
          response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" };
          break;
        }
        case "file": {
          const p = (!target.startsWith("/") && !target.startsWith("./")) ? `./${target}` : target;
          // ensure directory exists
          const slash = p.lastIndexOf("/");
          const dir = slash >= 0 ? p.slice(0, slash) : ".";
          if ((globalThis as any).Bun?.mkdir) {
            await (globalThis as any).Bun.mkdir(dir || ".", { recursive: true });
          } else {
            const fs = await import("fs");
            await fs.promises.mkdir(dir || ".", { recursive: true });
          }
          // unescape once if upstream gave "\\n"
          const text = (msg.includes("\\n") && !msg.includes("\n"))
            ? msg.replace(/\\r\\n/g, "\r\n").replace(/\\n/g, "\n")
            : msg;
          // overwrite
          if ((globalThis as any).Bun?.write) {
            await (globalThis as any).Bun.write(p, text + "\n", { create: true, append: false });
          } else {
            const fs = await import("fs");
            await fs.promises.writeFile(p, text + "\n", { encoding: "utf-8" });
          }
          response = {
            ts: Date.now().toString(),
            from: this.id,
            role: "tool",
            read: true,
            content: `=> Written to file ${p}`
          };
          logLine(`${RedTag()}******* wrote file ${p} @ ${stamp()}${Reset()}`);
          break;
        }
      }
    } catch (e: any) {
      // mirror your existing error push
      const p = (kind === "file")
        ? ((!target.startsWith("/") && !target.startsWith("./")) ? `./${target}` : target)
        : String(target);
      response = {
        ts: Date.now().toString(),
        from: this.id,
        role: "tool",
        read: true,
        content: `${JSON.stringify({ ok: false, err: String(e) })} Failed to write to file ${p}.`
      };
      logErr(`file write failed: ${String(e)}`);
    } finally {
      if (this.fileToRedirectTo) this.audience = { kind: "group", target: "*" };
      this.fileToRedirectTo = undefined;
    }
    return response ?? { ts: Date.now().toString(), from: this.id, role: "system", read: true, content: "(deliver: no-op)" };
  }
  // Queue incoming messages as unread; keep a copy in context with read:false.
  private _enqueue(msg: RoomMessage): void {
    const m: RoomMessage = {
      ts: new Date().toISOString(),
      role: msg.role === 'system' ? 'system' : (msg.from === this.id ? 'assistant' : 'user'),
      from: msg.from,
      content: msg.content,
      read: Boolean(msg.read) === true ? true : false, // default false unless explicitly true
    };
    // If not from self, consider unread (we let our own messages be read:true)
    if (m.from !== this.id && m.role !== 'system') m.read = false;
    this.context.push(m);
    // Only queue non-system messages that are not from self
    if (m.role !== 'system' && m.from !== this.id) this.inbox.push({ ...m, read: false });
    this.cleanContext();
  }

  // Drain all unread messages for this agent; mark them as read inside context.
  private _drainUnread(): RoomMessage[] {
    const batch = this.inbox.splice(0);
    if (batch.length) {
      // Mark matching context entries as read
      const set = new Set(batch.map(b => b.ts + '|' + b.from + '|' + b.content));
      for (const m of this.context) {
        const key = m.ts + '|' + m.from + '|' + m.content;
        if (!m.read && set.has(key)) m.read = true;
      }
    }
    return batch;
  }

  private _push(msg: RoomMessage): void { this._enqueue(msg); }

  private cleanContext() {
    const MAX = this.maxMessagesInContext;
    const { high, low } = this.contextWM;

    // If we’re below the HIGH watermark, do nothing.
    if (this.context.length <= high) return;

    // We’re over HIGH: compress the oldest portion so that
    // final length ≲ LOW + 1 (for the summary itself).
    const target = Math.max(low - 1, 1); // leave space for one summary message
    const needToDrop = Math.max(0, this.context.length - target);
    if (needToDrop <= 0) return;

    const head = this.context.slice(0, needToDrop);
    const tail = this.context.slice(needToDrop);

    // Deterministic summary of 'head' (no LLM)
    let toolCount = 0; let lastCmd = ""; const filesWritten: string[] = [];
    for (const m of head) {
      const c = String(m.content || "");
      if (m.role === 'tool') toolCount++;
      const cmdMatch = c.match(/\b(?:sh|bash)\b[^\n\r]*/i);
      if (cmdMatch) lastCmd = cmdMatch[0];
      const fileMatch = c.match(/#file:([^\s\n\r]+)/);
      if (fileMatch && fileMatch[1]) {
        filesWritten.push(fileMatch[1]);
      }
    }

    const headPreview = head
      .filter(m => m.role !== 'system')
      .slice(-4)
      .map(m => `${m.from}: ${String(m.content || "").replace(/\s+/g, ' ').slice(0, 140)}`)
      .join("\n");

    const summaryLines: string[] = [];
    summaryLines.push(`[summary] Compressed ${head.length} earlier turns.`);
    if (toolCount) summaryLines.push(`tools_used=${toolCount}` + (lastCmd ? ` last_cmd=\"${lastCmd.slice(0,120)}\"` : ''));
    if (filesWritten.length) summaryLines.push(`files_written=${filesWritten.slice(-5).join(',')}`);
    if (headPreview) summaryLines.push(`recent_head:\n${headPreview}`);

    const summaryMsg = {
      ts: new Date().toISOString(),
      role: 'system' as const,
      from: 'System',
      content: summaryLines.join("\n"),
      read: true,
    };

    this.context = [summaryMsg, ...tail];

    // Final clamp in case LOW is extremely small vs. incoming burst
    while (this.context.length > low + 1) this.context.shift();
  }

  private _appendSoC(s: string) {
    const clean = String(s || "")
      .replace(/<think>.*?<\/think>/gs, "") // drop hidden reasoning if present
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    this.socText = (this.socText + " " + clean);
    if (this.socText.length > this.maxSocChars) {
      this.socText = this.socText.slice(-this.maxSocChars);
    }
  }
}