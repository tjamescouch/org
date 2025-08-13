// --- Global pause helpers (for user input) ---
const isPaused = () => Boolean((globalThis as any).__PAUSE_INPUT);
const waitWhilePaused = async () => {
  while (isPaused()) { await new Promise(r => setTimeout(r, 50)); }
};
// --- Lightweight wrappers for unified logging ---
const __g: any = (globalThis as any) || {};
const logLine = (s: string) => { (console.log)(s); };
const logErr  = (s: string) => { ( console.error)(s); };
const appendDirect = (s: string) => { ( ((x: string)=>console.log(x)))(s.endsWith("\n")?s:(s+"\n")); };
const stamp = () => new Date().toLocaleTimeString();

const SHOW_THINK = (process.env.SHOW_THINK === "1" || process.env.SHOW_THINK === "true");

// --- Cooperative "user interrupt" flag (set from main on interject)
const __userInterrupt = { ts: 0 };
export function markUserInterject() { __userInterrupt.ts = Date.now(); }
export const Reset = () => "\x1b[0m";
export const CyanTag = () => "\x1b[36m";
export const YellowTag = () => "\x1b[33m";
export const RedTag = () => "\x1b[31m";
export const GreenTag = () => "\x1b[32m";
export const BlueTag = () => "\x1b[34m";
export const MagentaTag = () => "\x1b[35m";
export const WhiteTag = () => "\x1b[37m";
export const BrightBlackTag = () => "\x1b[90m"; // gray
export const BrightRedTag = () => "\x1b[91m";
export const BrightGreenTag = () => "\x1b[92m";
export const BrightYellowTag = () => "\x1b[93m";
export const BrightBlueTag = () => "\x1b[94m";
export const BrightMagentaTag = () => "\x1b[95m";
export const BrightCyanTag = () => "\x1b[96m";
export const BrightWhiteTag = () => "\x1b[97m";
const withTimeout = <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]) as any;
import { chatOnce, summarizeOnce, type ChatMessage, type ToolCall, type ToolDef, type AbortDetector } from "./chat";
import { Model } from "./model";
import { channelLock } from "./channel-lock";
import type { RoomMessage } from "./chat-room";
import { TagParser } from "./tag-parser";
import { extractToolCallsFromText } from "./tool-call-extractor";
import { VERBOSE } from './constants';

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
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  // pick 2–3 random words/fragments from the alphabet
  const randPart = () =>
    alphabet[Math.floor(Math.random() * alphabet.length)] +
    alphabet[Math.floor(Math.random() * alphabet.length)];

  // join prefix with 2–3 random parts
  return `${prefix}_${randPart()}_${randPart()}`;
}

/* ---------- Abort detectors (model-owned, pluggable) -------------------- */
class RegexAbortDetector implements AbortDetector {
  name = "regex";
  constructor(private patterns: RegExp[]) {}
  check(text: string, ctx: { messages: ChatMessage[]; agents: string[]; soc?: string }): { index: number; reason: string } | null {
    for (const re of this.patterns) {
      const m = re.exec(text);
      if (m) return { index: m.index, reason: String(re) };
    }
    return null;
  }
}

class MetaTagLeakDetector implements AbortDetector {
  name = "meta-tag-leak";
  // Detects leaked framework/control tokens and channel|commentary artifacts
  // Examples:
  //   "<|start|>", "<|im_start|>", "<|assistant|>", "<|tool|>", "<channel|commentary>"
  //   as well as any "<foo|commentary ...>" slack-style tag
  private re = /<\|[^>]*\|>|<\s*[a-z0-9_-]+\s*\|\s*commentary\b[^>]*>/i;
  check(text: string): { index: number; reason: string } | null {
    const m = this.re.exec(text);
    return m ? { index: m.index, reason: "meta/control-tag" } : null;
  }
}

class CrossTurnRepetitionDetector implements AbortDetector {
  name = "cross-turn";
  constructor(private cfg = {
    tailWords: 14,
    minChars: 120,
    minNoveltyRatio: 0.18,
    sampleSocChars: 12000,
  }) {}
  private tokenize(s: string): string[] {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }

  check(text: string, ctx?: { soc?: string }): { index: number; reason: string } | null {
    const soc: string = ctx && (ctx as any).soc ? String((ctx as any).soc) : "";
    if (!soc || text.length < this.cfg.minChars) return null;

    const toks = this.tokenize(text);
    if (toks.length < this.cfg.tailWords) return null;

    const tailStr = toks.slice(-this.cfg.tailWords).join(" ");
    const socSlice = soc.slice(-this.cfg.sampleSocChars);

    // Exact tail phrase seen in prior turns → cut where it begins
    if (socSlice.includes(tailStr)) {
      const idx = Math.max(0, text.toLowerCase().lastIndexOf(tailStr));
      return { index: idx > 0 ? idx : Math.max(0, text.length - tailStr.length), reason: "cross-turn-tail-repeat" };
    }

    // Novelty of recent text vs prior SoC
    const recentSet = new Set(toks.slice(-Math.min(160, toks.length)));
    const socSet = new Set(this.tokenize(socSlice));
    let overlap = 0;
    for (const w of recentSet) if (socSet.has(w)) overlap++;
    const novelty = 1 - (overlap / Math.max(1, recentSet.size));
    if (novelty < this.cfg.minNoveltyRatio) {
      return { index: text.length, reason: `cross-turn-low-novelty(${novelty.toFixed(2)})` };
    }
    return null;
  }
}

class AgentQuoteAbortDetector implements AbortDetector {
  name = "agent-quote";
  constructor(private agents: string[]) {}
  private esc(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  check(text: string, ctx: { messages: ChatMessage[]; agents: string[] }): { index: number; reason: string } | null {
    const list = (ctx?.agents?.length ? ctx.agents : this.agents).filter(Boolean);
    if (!list.length) return null;
    const pattern = `(^|\\n)\\s*(?:${list.map(this.esc).join("|")}):\\s`;
    const re = new RegExp(pattern, "i");
    const m = re.exec(text);
    if (m) {
      const cut = m.index;
      return { index: cut, reason: "agent-quote" };
    }
    return null;
  }
}

class RepetitionAbortDetector implements AbortDetector {
  name = "repetition";
  constructor(private cfg = {
    tailWords: 12,
    maxRepeats: 3,
    minWordsForNovelty: 120,
    minNoveltyRatio: 0.2,
  }) {}
  private tokenize(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }
  private esc(w: string) {
    return w.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
  }
  check(text: string): { index: number; reason: string } | null {
    const toks = this.tokenize(text);
    const total = toks.length;
    if (total >= this.cfg.minWordsForNovelty) {
      const uniq = new Set(toks).size;
      const novelty = uniq / total;
      if (novelty < this.cfg.minNoveltyRatio) {
        return { index: text.length, reason: `low-novelty(${novelty.toFixed(2)})` };
      }
    }
    const n = Math.min(this.cfg.tailWords, Math.max(3, Math.floor(total / 4)));
    if (total >= n) {
      const tail = toks.slice(total - n);
      const pattern = "\\b" + tail.map(this.esc).join("\\s+") + "\\b";
      const re = new RegExp(pattern, "g");
      let m: RegExpExecArray | null;
      let count = 0;
      let thirdIndex = -1;
      while ((m = re.exec(text)) !== null) {
        count++;
        if (count === this.cfg.maxRepeats) { thirdIndex = m.index; break; }
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      if (count >= this.cfg.maxRepeats && thirdIndex >= 0) {
        return { index: thirdIndex, reason: `phrase-loop(${n}w x${count})` };
      }
    }
    return null;
  }
}

class ToolEchoFloodDetector implements AbortDetector {
  name = "tool-echo-flood";
  constructor(private maxJsonEchoes = 2) {}
  check(text: string): { index: number; reason: string } | null {
    // Count likely tool-call JSON echoes in assistant content
    const re = /"tool_calls"\s*:\s*\[/g;
    let count = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      count++;
      if (count > this.maxJsonEchoes) {
        return { index: m.index, reason: `tool-call-json-echo>x${this.maxJsonEchoes}` };
      }
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return null;
  }
}

class SpiralPhraseDetector implements AbortDetector {
  name = "spiral-phrases";
  // Abort on telltale spiral phrases at start of line
  private re = /(^|\n)\s*(?:let(?:’|'|)s (?:run|try)|we need to (?:run|write|check)|it didn't show output\b|now create new file\b)/i;
  check(text: string): { index: number; reason: string } | null {
    const m = this.re.exec(text);
    return m ? { index: m.index, reason: "telltale-phrase" } : null;
  }
}

class MaxLengthAbortDetector implements AbortDetector {
  name = "max-length";
  constructor(private maxChars = 4000) {}
  check(text: string): { index: number; reason: string } | null {
    if (text.length > this.maxChars) {
      return { index: this.maxChars, reason: `max-chars>${this.maxChars}` };
    }
    return null;
  }
}

export class AgentModel extends Model {
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
    await this.broadcast(initialContent);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {
    // --- Fast-path: if the user has taken control, skip this turn entirely
    const PAUSED = Boolean((globalThis as any).__PAUSE_INPUT);
    const userJustInterjected = (Date.now() - __userInterrupt.ts) < 1500;
    if (PAUSED || userJustInterjected) {
      // Record the message for history but do not generate a response now.
      this._enqueue({ ...incoming, read: false });
      logLine(`${BrightYellowTag()}[skip] ${this.id}: user control active; skipping queued turn @ ${stamp()}${Reset()}`);
      return;
    }
    await waitWhilePaused();
    this._enqueue({ ...incoming, read: false });

    // Acquire the shared channel lock up-front so summarizeOnce and chatOnce do not overlap across agents
    const release = await channelLock.waitForLock(15 * 60 * 1000);
    // Guard again after acquiring the lock in case control changed while waiting
    if (Boolean((globalThis as any).__PAUSE_INPUT) || (Date.now() - __userInterrupt.ts) < 1500) {
      release();
      logLine(`${BrightYellowTag()}[skip] ${this.id}: user control after lock; yielding${Reset()}`);
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
        summaryText = await withTimeout(
          summarizeOnce([ summarizerSystem, ...tail, { role: "user", from: incoming.from, content: incoming.content, read: false } ], { model: this.model }),
          180_000,
          "summary timeout"
        ).catch(() => console.error("*********** summary timeout"));
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

      const normalizedHistory = this._viewForSelf(fullMessageHistory);
      const messages = await this.runWithTools(normalizedHistory, tools, (c) => this._execTool(c), 25);
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
    const responses: ChatMessage[] = [];
    const toolOptions = { tools, tool_choice: "auto" as const, num_ctx: 128000 };

    // --- Stuck breaker state ---
    let breakerCooldown = 0;            // when > 0, next hops run with tools disabled
    let breakerReason: string | null = null;
    let totalToolCallsThisTurn = 0;     // cap tool calls per run
    const MAX_TOOL_CALLS_PER_TURN = 10;
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
      const agents = Array.from(new Set(currentMessages.map(m => (m?.from || "").toLowerCase()).filter(Boolean)));
      const detectors: AbortDetector[] = [
        new CrossTurnRepetitionDetector({ tailWords: 20, minChars: 220, minNoveltyRatio: 0.08, sampleSocChars: 20000 }),
        new AgentQuoteAbortDetector(agents),
        new MetaTagLeakDetector(),
        new RepetitionAbortDetector({ tailWords: 20, maxRepeats: 6, minWordsForNovelty: 220, minNoveltyRatio: 0.04 }),
        new ToolEchoFloodDetector(4),
        new SpiralPhraseDetector(), // keep disabled for now
        new MaxLengthAbortDetector(12000),
        new RegexAbortDetector([ /\bnow create new file\b/i, /\bit didn't show output\b/i ]),
      ];

      let msg: any;
      const invokeChat = async (tempBump = 0) => {
        return await withTimeout(
          chatOnce(this.id, messagesForHop, {
            tools: toolsForHop,
            tool_choice: toolChoiceForHop,
            num_ctx: 128000,
            abortDetectors: detectors,
            model: this.model,
            soc: this.socText,
            temperature: (typeof (undefined as any) === "undefined" ? 1 : 1) + tempBump
          }),
          600_000,
          "chatOnce hop timeout"
        ).catch(e => console.error(e));
      }
      msg = await invokeChat(0);
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
        // Optionally surface chain-of-thought wrapper (kept as-is if present)
        if (SHOW_THINK && (msg as any).reasoning) {
          responses.push({
            role: "assistant",
            from: this.id,
            content: `<think>${(msg as any).reasoning}</think>`,
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
${CyanTag()}${sOut}${Reset()}
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
          await this.broadcast(String(msg ?? ""));
          response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" };
          break;
        }
        case "direct": {
          await this.broadcast(String(msg ?? ""), target);
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
      if (fileMatch) filesWritten.push(fileMatch[1]);
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
