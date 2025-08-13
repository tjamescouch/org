// agent-model.ts — repaired, self-contained AgentModel with tool execution and safe streaming integration

// --- Lightweight wrappers for unified logging ---
const __g: any = (globalThis as any) || {};
const logLine = (s: string) => { (__g.__log ?? console.log)(s); };
const logErr  = (s: string) => { (__g.__logError ?? console.error)(s); };
const appendDirect = (s: string) => { (__g.__appendLog ?? ((x: string)=>console.log(x)))(s.endsWith("\n")?s:(s+"\n")); };
// Helper for banner text (controls line)
const bannerText = () => "\x1b[97m\x1b[40m[q] quit  [i] interject  [s] system  (Ctrl+C to quit)\x1b[0m";
const stamp = () => new Date().toLocaleTimeString();
const Reset = () => "\x1b[0m";
const CyanTag = () => "\x1b[36m";
const YellowTag = () => "\x1b[33m";
const RedTag = () => "\x1b[31m";

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
import { VERBOSE } from "./constants";

/* ---------- helpers ---------- */
const isEmpty = (maybeArray: any[]): boolean => (maybeArray ?? []).length === 0;
const truncate = (s: string, length: number): string => (s.length <= length ? s : s.slice(0, length) + '...');
const makeToolCallId = (prefix: "call" | "tool"): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const randPart = () => alphabet[Math.floor(Math.random()*alphabet.length)] + alphabet[Math.floor(Math.random()*alphabet.length)];
  return `${prefix}_${randPart()}_${randPart()}`;
};

/* ---------- Abort detectors (model-owned, pluggable) -------------------- */
class RegexAbortDetector implements AbortDetector {
  name = "regex";
  constructor(private patterns: RegExp[]) {}
  check(text: string): { index: number; reason: string } | null {
    for (const re of this.patterns) { const m = re.exec(text); if (m) return { index: m.index, reason: String(re) }; }
    return null;
  }
}

class CrossTurnRepetitionDetector implements AbortDetector {
  name = "cross-turn";
  constructor(private cfg = { tailWords: 14, minChars: 120, minNoveltyRatio: 0.18, sampleSocChars: 12000 }) {}
  private tokenize(s: string): string[] { return String(s||"").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean); }
  check(text: string, ctx?: { soc?: string }): { index: number; reason: string } | null {
    const soc: string = (ctx as any)?.soc ? String((ctx as any).soc) : "";
    if (!soc || text.length < this.cfg.minChars) return null;
    const toks = this.tokenize(text); if (toks.length < this.cfg.tailWords) return null;
    const tailStr = toks.slice(-this.cfg.tailWords).join(" ");
    const socSlice = soc.slice(-this.cfg.sampleSocChars);
    if (socSlice.includes(tailStr)) {
      const idx = Math.max(0, text.toLowerCase().lastIndexOf(tailStr));
      return { index: idx > 0 ? idx : Math.max(0, text.length - tailStr.length), reason: "cross-turn-tail-repeat" };
    }
    const recentSet = new Set(toks.slice(-Math.min(160, toks.length)));
    const socSet = new Set(this.tokenize(socSlice));
    let overlap = 0; for (const w of recentSet) if (socSet.has(w)) overlap++;
    const novelty = 1 - (overlap / Math.max(1, recentSet.size));
    if (novelty < this.cfg.minNoveltyRatio) return { index: text.length, reason: `cross-turn-low-novelty(${novelty.toFixed(2)})` };
    return null;
  }
}

class AgentQuoteAbortDetector implements AbortDetector {
  name = "agent-quote";
  constructor(private agents: string[]) {}
  private esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  check(text: string, ctx: { agents: string[] }): { index: number; reason: string } | null {
    const list = (ctx?.agents?.length ? ctx.agents : this.agents).filter(Boolean);
    if (!list.length) return null;
    const pattern = `(^|\\n)\\s*(?:${list.map(this.esc).join("|")}):\\s`;
    const re = new RegExp(pattern, "i");
    const m = re.exec(text);
    return m ? { index: m.index, reason: "agent-quote" } : null;
  }
}

class RepetitionAbortDetector implements AbortDetector {
  name = "repetition";
  constructor(private cfg = { tailWords: 12, maxRepeats: 3, minWordsForNovelty: 120, minNoveltyRatio: 0.2 }) {}
  private tokenize(s: string): string[] { return s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean); }
  private esc(w: string) { return w.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&"); }
  check(text: string): { index: number; reason: string } | null {
    const toks = this.tokenize(text); const total = toks.length;
    if (total >= this.cfg.minWordsForNovelty) {
      const uniq = new Set(toks).size; const novelty = uniq/total;
      if (novelty < this.cfg.minNoveltyRatio) return { index: text.length, reason: `low-novelty(${novelty.toFixed(2)})` };
    }
    const n = Math.min(this.cfg.tailWords, Math.max(3, Math.floor(total/4)));
    if (total >= n) {
      const tail = toks.slice(total - n);
      const pattern = "\\b" + tail.map(this.esc).join("\\s+") + "\\b";
      const re = new RegExp(pattern, "g");
      let m: RegExpExecArray | null; let count = 0; let thirdIndex = -1;
      while ((m = re.exec(text)) !== null) { count++; if (count === this.cfg.maxRepeats) { thirdIndex = m.index; break; } if (re.lastIndex === m.index) re.lastIndex++; }
      if (count >= this.cfg.maxRepeats && thirdIndex >= 0) return { index: thirdIndex, reason: `phrase-loop(${n}w x${count})` };
    }
    return null;
  }
}

class ToolEchoFloodDetector implements AbortDetector {
  name = "tool-echo-flood";
  constructor(private maxJsonEchoes = 2) {}
  check(text: string): { index: number; reason: string } | null {
    const re = /"tool_calls"\s*:\s*\[/g; let count = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) { count++; if (count > this.maxJsonEchoes) return { index: m.index, reason: `tool-call-json-echo>x${this.maxJsonEchoes}` }; if (re.lastIndex === m.index) re.lastIndex++; }
    return null;
  }
}

class SpiralPhraseDetector implements AbortDetector {
  name = "spiral-phrases";
  private re = /(^|\n)\s*(?:let(?:’|'|)s (?:run|try)|we need to (?:run|write|check)|it didn't show output\b|now create new file\b)/i;
  check(text: string): { index: number; reason: string } | null { const m = this.re.exec(text); return m ? { index: m.index, reason: "telltale-phrase" } : null; }
}

class MaxLengthAbortDetector implements AbortDetector {
  name = "max-length";
  constructor(private maxChars = 4000) {}
  check(text: string): { index: number; reason: string } | null { return text.length > this.maxChars ? { index: this.maxChars, reason: `max-chars>${this.maxChars}` } : null; }
}

/* ---------- AgentModel -------------------- */
export type Audience = { kind: "group"; target: "*" } | { kind: "direct"; target: string } | { kind: "file"; target: string };

export class AgentModel extends Model {
  private context: RoomMessage[] = [];
  private readonly shellTimeout = 60 * 60; // seconds
  private audience: Audience = { kind: "group", target: "*" };
  private fileToRedirectTo: string | undefined;
  private maxShellReponseCharacters: number = 25_000;
  private maxMessagesInContext = 17;
  private system: string;
  private model: string;
  private socText: string = "";
  private readonly maxSocChars = 50_000;
  private readonly contextWM = {
    high: Math.max(this.maxMessagesInContext + 6, Math.ceil(this.maxMessagesInContext * 1.5)),
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

Be concise.`;
  }

  /* ------------------------------------------------------------ */
  async initialMessage(incoming: RoomMessage): Promise<void> {
    this._push(incoming);
    if (incoming.from !== this.id) return;

    const initialContent: string = (incoming && typeof incoming.content === "string") ? incoming.content : "";
    logLine(`${CyanTag()} **** ${this.id} @ ${stamp()}${Reset()}\n${initialContent}`);
    await this.broadcast(initialContent);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {
    this._push(incoming);

    const release = await channelLock.waitForLock(15 * 60 * 1000);
    try {
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
        summaryText = await withTimeout(
          summarizeOnce([ summarizerSystem, ...tail, { role: "user", from: incoming.from, content: incoming.content, read: false } ], { model: this.model }),
          180_000,
          "summary timeout"
        ).catch(() => "");
        if (summaryText) this._lastSummarizeTurn = this._turnCounter;
      }

      const dynamicSystem: ChatMessage | null = summaryText
        ? { role: "system", from: "System", content: `Context summary:\n${summaryText}` , read: true }
        : null;

      const tail = this.context.slice(-20);
      const fullMessageHistory: ChatMessage[] = [
        { role: "system", from: "System", content: this.system, read: false },
        ...(dynamicSystem ? [dynamicSystem] : []),
        ...tail,
        { role: "user", from: incoming.from, content: incoming.content, read: false },
      ];

      const tools: ToolDef[] = [ this._defShellTool() ];

      const messages = await this.runWithTools(fullMessageHistory, tools, (c) => this._execTool(c), 25);
      for (const m of messages) {
        const mappedRole = (m.role === 'tool') ? 'tool' : (m.from === this.id ? 'assistant' : 'user');
        this.context.push({ ts: new Date().toISOString(), role: mappedRole as any, from: m.from, content: m.content, read: true });
      }

      const wroteThisTurn = messages.some(m => m.role === 'tool' && /=>\s*Written to file/i.test(String(m.content || '')));
      if (!wroteThisTurn) {
        this.context.push({
          ts: new Date().toISOString(),
          role: 'system' as any,
          from: 'System',
          read: true,
          content: 'No files were written in the last turn. In your next reply: either write the required files using the #file:<relative/path> tag followed by the full file content, or provide a brief plain-text summary and explicit next step. Avoid repeating directory listings or re-reading the same files.'
        });
      }

      const lastMessage = messages[messages.length - 1];
      if (lastMessage) {
        await this._deliver((lastMessage.content ?? (lastMessage.reasoning ?? '')));
      } else {
        logErr('lastMessage is undefined');
      }

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
    let currentMessages: ChatMessage[] = [...messages];

    // Per-run detectors (used by chatOnce inside)
    const agents = Array.from(new Set(currentMessages.map(m => (m?.from || "").toLowerCase()).filter(Boolean)));
    const detectors: AbortDetector[] = [
      new CrossTurnRepetitionDetector({ tailWords: 20, minChars: 220, minNoveltyRatio: 0.08, sampleSocChars: 20000 }),
      new AgentQuoteAbortDetector(agents),
      new RepetitionAbortDetector({ tailWords: 20, maxRepeats: 6, minWordsForNovelty: 220, minNoveltyRatio: 0.04 }),
      new ToolEchoFloodDetector(4),
      // new SpiralPhraseDetector(), // leave disabled unless needed
      new MaxLengthAbortDetector(12000),
      new RegexAbortDetector([ /\bnow create new file\b/i, /\bit didn't show output\b/i ]),
    ];

    for (let hop = 0; hop < maxHops; hop++) {
      // nudge: tell the model to prefer #file for code
      const remainingCallsMsg: ChatMessage = {
        role: "system",
        from: "System",
        read: true,
        content: `If you need to output code or long text, do not chat it—write it using the #file:<relative/path> tag followed by the file content. Avoid recursive listings like ls -R.`,
      };
      const convo = [...currentMessages, remainingCallsMsg];

      const msg = await withTimeout(
        chatOnce(this.id, convo, {
          tools,
          tool_choice: tools.length ? "auto" : "none",
          num_ctx: 64000,
          abortDetectors: detectors,
          model: this.model,
          soc: this.socText,
        }),
        600_000,
        "chatOnce hop timeout"
      ).catch((e) => ({ role: "assistant" as const, content: `Error: ${String(e?.message || e)}` }));

      // Parse tags and collect tool calls
      const rawContent = (msg as any).content ?? "";
      const { clean: response, tags } = TagParser.parse(String(rawContent));
      const extractedAll = extractToolCallsFromText(String(rawContent)).tool_calls || [];
      const tool_calls: ToolCall[] = [ ...(((msg as any).tool_calls ?? []) as ToolCall[]), ...extractedAll ];

      // Assistant-visible text
      const visible = String(response ?? "").trim();
      if (visible) {
        responses.push({ role: "assistant", from: this.id, content: visible, reasoning: (msg as any).reasoning, read: true });
        currentMessages = [...currentMessages, { role: "assistant", from: this.id, content: visible, read: true }];
      }

      // Handle #file and @agent tags immediately
      if (tags.length > 0) {
        const savedAudience = { ...this.audience } as any;
        for (const t of tags) {
          if (t.kind === "file") {
            this.fileToRedirectTo = t.value;
            const statusMsg = await this._deliver(t.content ?? "");
            if (statusMsg) responses.push(statusMsg);
            currentMessages = [...currentMessages, statusMsg as any];
          } else if (t.kind === "agent") {
            this.audience = { kind: "direct", target: t.value } as any;
            const delivered = await this._deliver(t.content ?? "");
            if (delivered) responses.push(delivered);
            currentMessages = [...currentMessages, delivered as any];
            this.audience = { ...savedAudience } as any;
          }
        }
      }

      // No tool calls => finished
      if (!tool_calls || tool_calls.length === 0) break;

      // Execute tools sequentially and feed results back
      for (const call of tool_calls) {
        const toolMsg = await execTool(call).catch((e) => ({
          role: "tool" as const,
          name: call.function?.name || "unknown",
          tool_call_id: call.id || makeToolCallId("tool"),
          content: `Tool error: ${String(e?.message || e)}`,
          from: this.id,
          read: true,
        }));
        // record tool result
        currentMessages = [...currentMessages, toolMsg];
        // surface a brief assistant acknowledgement so the turn has visible progress
        responses.push({ role: "assistant", from: this.id, content: `Executed tool: ${call.function?.name || "unknown"}`, read: true });
      }
    }

    return responses;
  }

  /* ---------- Tools ---------- */
  private _defShellTool(): ToolDef {
    return {
      type: "function",
      function: {
        name: "sh",
        description: "Run a POSIX shell command inside the Debian VM. Use for short commands. For long code, write files using #file:<path> tags.",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "Command to run, e.g., \"ls -l\" or \"bash -lc \\\"make\\\"\"" },
            timeout: { type: "integer", minimum: 1, maximum: 3600, description: "Optional timeout in seconds" },
          },
          required: ["cmd"],
          additionalProperties: false,
        },
      },
    };
  }

  private async _execTool(call: ToolCall): Promise<ChatMessage> {
    const name = call?.function?.name || "unknown";
    const id = call?.id || makeToolCallId("tool");
    let args: any = {};
    try { args = call?.function?.arguments ? JSON.parse(String(call.function.arguments)) : {}; } catch {}
    if (name !== "sh") {
      return { role: "tool", name, tool_call_id: id, content: `Invalid response: unknown tool \"${name}\"`, from: this.id, read: true } as any;
    }
    const cmd = String(args?.cmd || "").trim();
    const timeoutSec = Math.max(1, Math.min(3600, Number(args?.timeout || this.shellTimeout)));
    if (!cmd) {
      return { role: "tool", name, tool_call_id: id, content: "Invalid response: missing cmd", from: this.id, read: true } as any;
    }

    let ok = false; let stdout = ""; let stderr = ""; let exit_code = -1;
    try {
      const p = Bun.spawn(["bash", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
      const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutSec * 1000);
      await p.exited; clearTimeout(t);
      exit_code = p.exitCode;
      ok = exit_code === 0;
      stdout = await new Response(p.stdout).text();
      stderr = await new Response(p.stderr).text();
    } catch (e: any) {
      stderr = String(e?.message || e);
      ok = false;
      exit_code = -1;
    }

    const cap = this.maxShellReponseCharacters;
    const body = {
      ok,
      stdout: truncate(stdout, cap),
      stderr: truncate(stderr, cap),
      exit_code,
    };

    const pretty = JSON.stringify(body);
    appendDirect(`${YellowTag()}******* sh ${truncate(cmd, 120)} ->  ${Reset()} ${pretty}`);

    return { role: "tool", name: "sh", tool_call_id: id, content: pretty, from: this.id, read: true } as any;
  }

  /* ---------- Delivery & bookkeeping ---------- */
  private async _deliver(text: string): Promise<ChatMessage | null> {
    const content = String(text ?? "");
    if (this.audience.kind === "file" || this.fileToRedirectTo) {
      const path = this.fileToRedirectTo || (this.audience as any).target;
      this.fileToRedirectTo = undefined; // one-shot redirect
      try {
        await Bun.write(path, content);
        const msg = { role: "tool" as const, name: "file", tool_call_id: makeToolCallId("tool"), content: `=> Written to file: ${path} (${content.length} bytes)`, from: this.id, read: true };
        appendDirect(`${YellowTag()}${msg.content}${Reset()}`);
        appendDirect(bannerText());
        return msg as any;
      } catch (e: any) {
        const msg = { role: "tool" as const, name: "file", tool_call_id: makeToolCallId("tool"), content: `File write failed: ${path} — ${String(e?.message || e)}`, from: this.id, read: true };
        appendDirect(`${RedTag()}${msg.content}${Reset()}`);
        appendDirect(bannerText());
        return msg as any;
      }
    }

    const head = `${CyanTag()}**** ${this.id} @ ${stamp()}${Reset()}`;
    appendDirect(`\n${head}\n${content}`);
    appendDirect(bannerText());
    return { role: "assistant", from: this.id, content, read: true } as any;
  }

  private _appendSoC(text: string) {
    this.socText += (this.socText ? "\n" : "") + text;
    if (this.socText.length > this.maxSocChars) this.socText = this.socText.slice(-this.maxSocChars);
  }

  private _push(m: RoomMessage) { this.context.push(m); if (this.context.length > 200) this.context.shift(); }

  private cleanContext() {
    // Hysteresis: only summarize when beyond HIGH; then trim to LOW
    if (this.context.length <= this.contextWM.high) return;
    const sys = { role: "system", from: "System", content: this.system, read: false } as any;
    const tail = this.context.slice(-this.contextWM.low);
    this.context = [sys, ...tail];
  }
}