import { chatOnce, type ChatMessage, type ToolCall, type ToolDef } from "./chat";
import { Model } from "./model";
import { channelLock } from "./channel-lock";
import type { RoomMessage } from "./chat-room";
import { TagParser } from "./tag-parser";
import { extractToolCallsFromText } from "./tool-call-extractor";

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

export class AgentModel extends Model {
  private readonly context: RoomMessage[] = [];
  private readonly shellTimeout = 5 * 60; // seconds
  private audience: Audience = { kind: "group", target: "*" }; // default
  private fileToRedirectTo: string | undefined;
  private maxShellReponseCharacters: number = 50_000;
  private maxMessagesInContext = 100;
  private system: string;

  constructor(id: string) {
    super(id);

    this.system = `You are agent "${this.id}".
If you need to run shell commands, call the sh tool. If you misuse a tool you will get an "Invalid response" message.
Commands are executed in a Debian VM.
Try to make decisions for yourself even if you're not completely sure that they are correct.
You have access to an actual Debian VM.
It has git, gcc and bun installed.

You have access to basic unix commands.
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
You may only use multple tags per response. Please avoid leaking your thoughts/interjections into the files. If you must, comment them out.
Remember all content after a tag and before the next tag is applied to the first tag.


Example of leaking thoughts:
#file:Makefile
CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Iinclude
...
.PHONY: all clean
Now utils.h #file:utils.h
include ...

The Makefile will end up with "Now utils.h" at the end.
Instead either do not say anything unnecessary or comment it out:

Option A (Preferred):
#file:Makefile
CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Iinclude
...
.PHONY: all clean
#file:utils.h
include ...

Option B:
#file:Makefile
CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Iinclude
...
.PHONY: all clean
# Now utils.h #file:utils.h
include ...

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

Be polite and friendly with your team members.

Above all - DO THE THING. Don't just talk about it.
DO NOT write <username>: ...
The above is likely a hallucination. Stop yourself.


Now commit changes to git.{"id":"call_ri_ka","object":"chat.completion","created":1754860271234,"model":"gpt-oss:120b","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_ri_ka","index":0,"type":"function","function":{"name":"sh","arguments":"{\"cmd\":\"git add Makefile && git commit -m \\\"chore: fix Makefile for proper build\\\"\"}"}}]},"finish_reason":"tool_calls"}]}alice: {"ok":true,"stderr":"","stdout":"[master (root-commit) 5c5c5c5] chore: fix Makefile for proper build\n 1 file changed, 30 insertions(+), 0 deletions(-)\n"}************** CALL {
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
    const fullMessageHistory: ChatMessage[] = [
      { role: "system", from: "System", content: this.system, read: false },
      ...this.context,
      { role: "system", from: "System", content: this.system, read: false },
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
    const toolOptions = { tools, tool_choice: "auto" as const, num_ctx: 128000 };

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

    for (let hop = 0; hop < maxHops; hop++) {
      // Ask the model what to do next given the *internal* conversation
      const msg = (await chatOnce(this.id, currentMessages, toolOptions)) ?? { content: "Error" } as any;

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
        if (trimmed.length > 0 && !looksLikeToolJson(trimmed)) {
          responses.push({
            role: "assistant",
            from: this.id,
            content: trimmed,
            reasoning: (msg as any).reasoning,
            read: true,
          });
        }

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
      for (const call of tool_calls) {
        const toolMsg = await execTool(call); // { role:"tool", name, tool_call_id, content, from, read }
	currentMessages.push({
          role: "assistant",
          from: this.id,
          content: JSON.stringify({
            id: makeToolCallId("call"),
            object: "chat.completion",
            created: new Date().getTime(),
            model: "gpt-oss:120b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: makeToolCallId("call"),
                      index: 0,
                      type: "function",
                      function: {
                        name: "sh",
                        arguments:
                          typeof (call as any)?.function?.arguments === "object"
                            ? JSON.stringify((call as any)?.function?.arguments)
                            : (call as any)?.function?.arguments,
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          reasoning: (msg as any).reasoning,
          read: true,
        });
        // Append internally so the next assistant step can read it
        currentMessages.push(toolMsg);
      }

      // Also handle tags **in the same hop** (don't skip tools). This mirrors previous behavior.
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

      // Loop back: the next chatOnce() sees the tool outputs via currentMessages
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
    console.error("************** CALL", call);
    const name: string = call?.function?.name ?? 'unknown';
    try {
      // Ensure arguments are parsed safely and type matches expected signature
      const args = JSON.parse(call?.function?.arguments ?? '{"cmd": ""}') as { cmd: string };
      if (name === "sh") {
        return { ...(await this._runShell(name, { ...args, rawCmd: args.cmd })), tool_call_id: call.id, role: "tool", name, from: this.id, read: false };
      }
      // unknown tool
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: `unknown tool: ${name}` }), from: this.id, read: false };
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

  private cleanContext() {
    while (this.context.length > this.maxMessagesInContext) this.context.shift();
  }
}
