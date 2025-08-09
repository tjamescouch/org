import { chatOnce, type ChatMessage, type ToolCall, type ToolDef } from "./chat";
import { Model } from "./model";
import {  writeFileSync } from "fs";
import { channelLock } from "./channel-lock";
import type { RoomMessage } from "./chat-room";
import { TagParser } from "./tag-parser";

type Audience =
  | { kind: "group"; target: "*" }
  | { kind: "direct"; target: string }      // send only to a given model
  | { kind: "file"; target: string };         // append to a file on host FS

const isEmpty = (maybeArray: unknown[]): boolean => {
  return (maybeArray ?? []).length === 0;
}

export class AgentModel extends Model {
  private readonly context: RoomMessage[] = [];
  private readonly maxTurns: number;
  private readonly shellTimeout = 5 * 60; // seconds
  private audience: Audience = { kind: "group", target: "*" }; // default
  private fileToRedirectTo: string | undefined;

  constructor(id: string, maxTurns = 5) {
    super(id);
    this.maxTurns = maxTurns;
  }

  /* ------------------------------------------------------------ */
  async initialMessage(incoming: RoomMessage): Promise<void> {
    this._push(incoming);
    console.log(`\n\n*** ${this.id}:\n${incoming.content}`);

    await this.broadcast(incoming.content);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {

    const system = `You are agent "${this.id}". 
    If you need to run shell commands, call the tool "sh". Commands are executed in a Debian VM.
    To chat directly to another agent use the chat_mode tool. Examples: group, direct:bob - to talk to the group or directly to bob respectively.
    Try to make decisions for yourself even if you're not completely sure that they are correct.
    You have access to an actual Debian VM.
    It has git and bun installed.
    PLEASE use the file system.
    You have access to basic unix commands. There is no unix command called apply_patch nor is there a tool with that name.
    You have the unix 'patch' command as well as bun, git, echo, cat, etc. Use these to manipulate files.

    Alternately: to write to a file include a tag at the very start of the response with the format #file:<filename>. This way you do not do a tool call and simply respond.
    Example:
    #file:index.ts
    console.log("hello world");

    Prefer the above tagging approach for writing files longer than a few paragraphs.
    PLEASE stream files to disk rather than just chatting them with the group.
    PLEASE run shell commands and test your work.
    DO NOT do the same thing over and over again (infinite loop)
    If you get stuck reach out to the group for help.
    Delegate where appropriate and avoid doing work that should be done by another agent.
    Please actually use the tools provided. Do not simply hallucinate tool calls.
    Be concise.
    `;

    const seed: ChatMessage[] = [
      ...this.context,
      { role: "system", from: "System", content: system },
      { role: "user", from: incoming.from, content: incoming.content},
    ];

    this._push(incoming);

    const tools: ToolDef[] = [
      this._defShellTool(),
      this._defChatModeTool(),
    ];

    const release = await channelLock.waitForLock(15 * 60 * 1000);
    let reply;

    try {
      reply = await this.runWithTools(seed, tools, (c) => this._execTool(c), 15);
    } finally {
      release();
    }

    const lastReply = reply[reply.length - 1];

    if (lastReply) {
      this.fileToRedirectTo = lastReply.recipient;
      if (this.fileToRedirectTo) {
        this.audience = { kind: "file", target: this.fileToRedirectTo }
      }
      await this._deliver(lastReply.content || lastReply.reasoning || '');
    }
  }


  async runWithTools(
    seed: ChatMessage[],
    tools: ToolDef[],
    execTool: (call: ToolCall) => Promise<ChatMessage>, // returns a {role:"tool", name, tool_call_id, content}
    maxHops: number
  ): Promise<ChatMessage[]> {

    let messages = seed.slice();
    for (let i = 0; i < maxHops; i++) {
      const msg = await chatOnce(this.id, messages, { tools, tool_choice: "auto", num_ctx: 128000 }) ?? { content: 'Error' };
      const { clean: response, tags } = TagParser.parse(msg.content || '');

      const content = isEmpty(msg.tool_calls ?? []) ? response : undefined;


      if(msg.reasoning) messages.push({ role: "assistant", from: this.id, content: `<think>${msg.reasoning}</think>`, reasoning: msg.reasoning});
      if(msg.content && content) messages.push({ role: "assistant", from: this.id, content, reasoning: msg.reasoning, recipient: tags[0]?.value });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return messages;
      }


      // Execute tool calls and append results
      for (const call of msg.tool_calls) {
        const toolMsg = await execTool(call);
        messages.push(toolMsg);
      }
    }
    //return { role: "system", from: "System", content: "[tool-error] exceeded tool-calling limit" };
    return messages;
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

  private _defChatModeTool(): ToolDef {
    return {
      type: "function",
      function: {
        name: "chat_mode",
        description: "Switch the agent's audience. Examples: group, direct:bob",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
          required: ["mode"],
        },
      },
    };
  }

  /* ------------------------------------------------------------ */
  private async _execTool(call: ToolCall): Promise<ChatMessage> {
    const { name } = call.function;

    try {
      const args = JSON.parse(call.function.arguments || "{}");

      if (name === "sh") {
        return { ...await this._runShell(name, args), tool_call_id: call.id, role: "tool", name, from: this.id };
      }
      if (name === "chat_mode") {
        this._setAudience(String(args.mode ?? "group"));
        return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: true }), from: this.id };
      }

      // unknown tool
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: "unknown tool" }), from: this.id };
    } catch (err) {
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: String(err) }), from: this.id };
    }
  }

  /* ---------- shell helper (Bun.spawn) ------------------------- */
  private async _runShell(functionName: string, { cmd }: { cmd: string }): Promise<{role: string, name: string, content: string}> {

    const timeout = Math.max(1, Math.min(30, Number(this.shellTimeout)));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (timeout + 1) * 1000);

    try {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", signal: ac.signal });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const content =`Tool: ${functionName} Command: ${cmd} -> ` + JSON.stringify({ ok: code === 0, stdout, stderr, exit_code: code })
      console.log(`\n\n\n******* sh -> ${content}`);
      return {
        role: "tool",
        name: "sh",
        content,
      };
    } catch (e) {
      const content =`sh -c ${cmd} -> ` + JSON.stringify({ ok: false, err: e instanceof Error ? e.message : String(e) })
      console.log(`\n\n\n******* sh -> ${content}`);
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

  private async _deliver(msg: string) {
    const kind = this.fileToRedirectTo ? "file" : this.audience.kind;
    const target = this.fileToRedirectTo ? this.fileToRedirectTo : this.audience.target;

    switch (kind) {
      case "group":
        await this.broadcast(msg);
        this._push({ ts: Date.now().toString(), from: this.id, content: msg, read: true, role: 'assistant' });
        break;
      case "direct":
        await this.broadcast(msg, this.audience.target);
        this._push({ ts: Date.now().toString(), from: this.id, content: msg, read: true, role: 'assistant' });
        break;
      case "file":
        let p = this.audience.target;
        if (!p.startsWith('/') && !p.startsWith('./')) {
          p = `./${p}`
        }

        try {
          writeFileSync(p, msg + "\n", { flag: "w+", encoding: "utf-8" });
          this._push({ ts: Date.now().toString(), from: this.id, content: `${msg}\nWritten to file ${p}`, role: 'assistant', read: true });
        } catch (e) {
          console.error(`******* file append failed: ${e}`);
          this._push({ ts: Date.now().toString(), from: this.id, content: `${msg}\nFailed to write to file ${p}.`,  read: true, role: 'assistant' });
        }
        break;
    }

    if (this.fileToRedirectTo) this.audience = { kind: "group", target: "*" };
  }

  private _push(msg: RoomMessage): void {
    this.context.push({
      ts: new Date().toISOString(),
      role: msg.from === this.id ? "assistant" : "user",
      from: msg.from,
      content: msg.content,
      read: true,
    });
    const maxEntries = this.maxTurns * 2;
    while (this.context.length > maxEntries) this.context.shift();
  }
}
