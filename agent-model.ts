const withTimeout = <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]) as any;
import { chatOnce, summarizeOnce, type ChatMessage, type ToolCall, type ToolDef, type AbortDetector } from "./chat";
import { Model } from "./model";
import {  writeFileSync } from "fs";
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
  check(text: string): { index: number; reason: string } | null {
    for (const re of this.patterns) {
      const m = re.exec(text);
      if (m) return { index: m.index, reason: String(re) };
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
  private readonly context: RoomMessage[] = [];
  private readonly shellTimeout = 5 * 60; // seconds
  private audience: Audience = { kind: "group", target: "*" }; // default
  private fileToRedirectTo: string | undefined;
  private maxShellReponseCharacters: number = 25_000;
  private maxMessagesInContext = 50;
  private system: string;

  constructor(id: string) {
    super(id);

    this.system = `You are agent "${this.id}".
If you need to run shell commands, call the sh tool. If you misuse a tool you will get an "Invalid response" message.
Commands are executed in a Debian VM.
Try to make decisions for yourself even if you're not completely sure that they are correct.
You have access to an actual Debian VM.
It has git, gcc and bun installed.

You have access to basic unix commands including pwd, cd, git, gcc, g++, python3, ls, cat, echo, diff, grep, curl. 
You have access to the apply_patch via the sh command.
Alternately: to write to a file include a tag with the format #file:<filename>. Follow the syntax exactly. i.e. lowercase, with no spaces.
This way you do not do a tool call and simply respond.

Example:
#file:index.ts
console.log("hello world");

Any output after the tag, and before another tag, will be redirected to the file, so avoid accidentally including other output or code fences etc. Just include the desired content of the file.
If multiple tags are present then multiple files will be written.

Terminal responses are limited to ${this.maxShellReponseCharacters} characters. 
DO NOT do a recursive list (ls -R) as this may result in a lot of characters.
Instead navigate around and explore the directories.

Prefer the above tagging approach for writing files longer than a few paragraphs.
You may only use one tag per response.


You may direct message another agent using the following tag syntax: @<username>

Example:
@bob
I have implemented the architecture documents.

Prefer direct messages when the information is not important to other members of the group.
Responses with no tags are sent to the entire group.

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
`;
  }

  /* ------------------------------------------------------------ */
  async initialMessage(incoming: RoomMessage): Promise<void> {
    this._push(incoming);
    const initialContent: string = (incoming && typeof incoming.content === "string")
      ? incoming.content
      : "";

    console.log(`\n\n**** ${this.id}:\n${initialContent}`);
    await this.broadcast(initialContent);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {
    // Keep a short tail for the LLM and add a dynamic summary system message
    const tail = this.context.slice(-20); // recent context only
    const summarizerSystem = {
      role: "system" as const,
      from: "System",
      content:
        "You are a succinct coordinator. Summarize the recent conversation as bullet points covering: current project goal, key constraints, files created/modified, tools/commands run and outcomes, and next concrete steps. Max 120 words. No code. No quotes.",
      read: true,
    };
    const summaryText = await withTimeout(
      summarizeOnce([ summarizerSystem, ...tail, { role: "user", from: incoming.from, content: incoming.content, read: false } ]),
      12_000,
      "summary timeout"
    ).catch(() => "");

    const dynamicSystem: ChatMessage | null = summaryText
      ? { role: "system", from: "System", content: `Context summary:\n${summaryText}`, read: true }
      : null;

    const fullMessageHistory: ChatMessage[] = [
      { role: "system", from: "System", content: this.system, read: false },
      ...(dynamicSystem ? [dynamicSystem] : []),
      ...tail,
      { role: "user", from: incoming.from, content: incoming.content, read: false },
    ];

    this._push(incoming);

    const tools: ToolDef[] = [
      this._defShellTool(),
    ];

    const release = await channelLock.waitForLock(15 * 60 * 1000);

    try {
      const messages = await this.runWithTools(fullMessageHistory, tools, (c) => this._execTool(c), 15);
      for (const message of messages) {
        this.context.push({
          ts: new Date().toISOString(),
          role: (message.role === 'tool') ? 'user' : (message.from === this.id ? 'assistant' : 'user'),
          from: message.from,
          content: message.content,
          read: true,
        });
      }

      const lastMessage = messages[messages.length - 1];
      if (lastMessage) {
        await this._deliver((lastMessage.content ?? (lastMessage.reasoning ?? '')));
      } else {
        console.error('lastMessage is undefined');
      }
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
    const toolOptions = { tools, tool_choice: "auto" as const, num_ctx: 8192 };

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
      // Build per-hop abort detectors (model controls policy)
      const agents = Array.from(new Set(currentMessages.map(m => (m?.from || "").toLowerCase()).filter(Boolean)));
      const detectors: AbortDetector[] = [
        new AgentQuoteAbortDetector(agents),
        new RepetitionAbortDetector({ tailWords: 16, maxRepeats: 4, minWordsForNovelty: 160, minNoveltyRatio: 0.18 }),
        new ToolEchoFloodDetector(2),
        // new SpiralPhraseDetector(),     // disabled for now
        new MaxLengthAbortDetector(8000),
        new RegexAbortDetector([
          /\bnow create new file\b/i,
          /\bit didn't show output\b/i,
        ]),
      ];

      const msg = (await withTimeout(
        chatOnce(this.id, currentMessages, { ...toolOptions, abortDetectors: detectors }),
        90_000,
        "chatOnce hop timeout"
      )) ?? { content: "Error" } as any;

      // Parse tags from assistant content
      const { clean: response, tags } = TagParser.parse(msg.content || "");

      // Collect declared + embedded tool calls
      const extractedToolCall = extractToolCallsFromText(msg.content ?? "").tool_calls[0];
      const tool_calls = [
        ...(msg.tool_calls ?? []),
      ];

      if (extractedToolCall) {
        tool_calls.push(extractedToolCall);
      }

      // If there are *no* tool calls, this is a summary/final assistant message.
      if (!tool_calls || tool_calls.length === 0) {
        // Optionally surface chain-of-thought wrapper (kept as-is if present)
        if ((msg as any).reasoning) {
          responses.push({
            role: "assistant",
            from: this.id,
            content: `<think>${(msg as any).reasoning}</think>`,
            reasoning: (msg as any).reasoning,
            read: true,
          });
        }

        const trimmed = String(response ?? "").trim();
        const finalText = trimmed.length > 0 ? trimmed : "(no content)";
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
            } else if (t.kind === "agent") {
              this.audience = { kind: "direct", target: t.value } as any;
              const delivered = await this._deliver(t.content ?? "");
              if (delivered) responses.push(delivered);
              this.audience = { ...savedAudience } as any;
            }
          }
        }

        break; // finished; no more tools requested
      }

      // There *are* tool calls this hop: execute them and feed back results as role:"tool"
      let lastSig: string | undefined;
      for (const call of tool_calls) {
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
          break;
        }
        // Debounce repeats seen in the last few hops
        if (seenRecently(sig)) {
          responses.push({ role: "assistant", from: this.id, read: true, content: `Skipping recently repeated tool call: ${call?.function?.name} ${call?.function?.name}` });
          continue;
        }
        lastSig = sig;
        rememberSig(sig);

        // Execute the tool and append its role:"tool" result so the next hop can see it
        const toolMsg = await execTool(call); // { role:"tool", name, tool_call_id, content, from, read }
        responses.push(toolMsg);
      }

      // Also handle tags **in the same hop** (don’t skip tools). This mirrors previous behavior.
      if (tags.length > 0) {
        const savedAudience = { ...this.audience } as any;
        for (const t of tags) {
          if (t.kind === "file") {
            this.fileToRedirectTo = t.value;
            const statusMsg = await this._deliver(t.content ?? "");
            if (statusMsg) responses.push(statusMsg);
          } else if (t.kind === "agent") {
            this.audience = { kind: "direct", target: t.value } as any;
            const delivered = await this._deliver(t.content ?? "");
            if (delivered) responses.push(delivered);
            this.audience = { ...savedAudience } as any;
          }
        }
      }
      // Feed back everything produced so far (assistant messages + tool outputs)
      currentMessages = [...messages, ...responses];
      // Loop back: the next chatOnce() sees the tool outputs via currentMessages
    }

    if (responses.length === 0) {
      responses.push({ role: "assistant", from: this.id, content: "(no content)", read: true });
    }
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
    if (VERBOSE) console.error("************** CALL", call);

    const name: string = call?.function?.name ?? 'unknown';
    try {
      // Ensure arguments are parsed safely and type matches expected signature
      const args = JSON.parse(call?.function?.arguments ?? '{"cmd": ""}') as { cmd: string };
      if (name === "sh" || name === "assistant") {
        return { ...(await this._runShell(name, { ...args, rawCmd: args.cmd })), tool_call_id: call.id, role: "tool", name, from: this.id, read: false };
      }
      // unknown tool
      console.error(`******** Model attempted to use an unknown tool ${name}`);
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
      //const content =truncate(`${ functionName ? `Tool ${functionName}: ` : '' } Command: '${sanitizedCmd ?? rawCmd ?? cmd}' -> ` + JSON.stringify({ ok: code === 0, stdout, stderr, exit_code: code }), this.maxShellReponseCharacters);
      const content =truncate(JSON.stringify({ ok: code === 0, stdout, stderr, exit_code: code }), this.maxShellReponseCharacters);

      console.error(`\n\n\n******* sh ${cmd ?? rawCmd} -> `, content);
      return {
        role: "tool",
        name: "sh",
        content,
      };
    } catch (e) {
      const content =`sh -c ${cmd} -> ` + JSON.stringify({ ok: false, err: e instanceof Error ? e.message : String(e) })
      console.error(`\n\n\n******* sh -> `, content);
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
    console.log("********* Setting chat mode: ", modeStr);
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
            content: `\`\`\`${text}\`\`\`\n=> Written to file ${p}`
          };
          console.log(`\n******* wrote file ${p}`);
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
      console.error(`\n******* file write failed: ${e}`);
      console.error(e);
    } finally {
      if (this.fileToRedirectTo) this.audience = { kind: "group", target: "*" };
      this.fileToRedirectTo = undefined;
    }
    return response ?? { ts: Date.now().toString(), from: this.id, role: "system", read: true, content: "(deliver: no-op)" };
  }
  private _push(msg: RoomMessage): void {
    this.context.push({
      ts: new Date().toISOString(),
      role: msg.role === 'system' ? 'system' : (msg.from === this.id ? 'assistant' : 'user'),
      from: msg.from,
      content: msg.content,
      read: true,
    });
    this.cleanContext();
  }

  private cleanContext() { // If within limit, nothing to do
    const MAX = this.maxMessagesInContext;
    if (this.context.length <= MAX) return;

    // Keep the most recent ~60% verbatim; summarize the older head into one system note
    const keepTail = Math.floor(MAX * 0.6);
    const dropCount = this.context.length - keepTail;
    const head = this.context.slice(0, dropCount);
    const tail = this.context.slice(dropCount);

    // Deterministic, lightweight summary (no LLM): count tools, last cmd, files written, last few lines
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
    while (this.context.length > MAX) this.context.shift();
  }
}
