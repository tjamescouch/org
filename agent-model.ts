import { chatOnce, type ChatMessage, type ToolCall, type ToolDef } from "./chat";
import { Model } from "./model";
import {  writeFileSync } from "fs";
import { channelLock } from "./channel-lock";
import type { RoomMessage } from "./chat-room";
import { TagParser } from "./tag-parser";

type Audience =
  | { kind: "group"; target: "*" } | { kind: "direct"; target: string }      // send only to a given model
  | { kind: "file"; target: string };         // write to a file on VM

const isEmpty = (maybeArray: unknown[]): boolean => {
  return (maybeArray ?? []).length === 0;
}

const truncate = (s: string, length: number): string => {
  if (s.length <= length) {
    return s;
  }
  return s.slice(0, length) + '...';
}

export class AgentModel extends Model {
  private readonly context: RoomMessage[] = [];
  private readonly shellTimeout = 5 * 60; // seconds
  private audience: Audience = { kind: "group", target: "*" }; // default
  private fileToRedirectTo: string | undefined;
  private maxShellReponseCharacters: number = 7000;
  private maxMessagesInContext = 20;

  constructor(id: string) {
    super(id);
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
    You have the unix 'patch' command as well as cd, pwd, bun, git, echo, cat, etc. Use these to manipulate files.

    Alternately: to write to a file include a tag at the very start of the response with the format #file:<filename>. This way you do not do a tool call and simply respond.
    Example:
    #file:index.ts
    console.log("hello world");

    Any output after the tag will be redirected to the file, so avoid accidentally including other output or code fences etc. Just include the desired content of the file.

    Terminal responses are limited to ${this.maxShellReponseCharacters} characters. So avoid ls -R on directories with many files.

    Prefer the above tagging approach for writing files longer than a few paragraphs.
    You may only use one tag per response.
    PLEASE stream files to disk rather than just chatting them with the group.
    PLEASE run shell commands and test your work.
    DO NOT do the same thing over and over again (infinite loop)
    If you get stuck reach out to the group for help.
    Delegate where appropriate and avoid doing work that should be done by another agent.
    Please actually use the tools provided. Do not simply hallucinate tool calls.
    Be concise.
    `;

    const fullMessageHistory: ChatMessage[] = [
      ...this.context,
      { role: "system", from: "System", content: system, read: false},
      { role: "user", from: incoming.from, content: incoming.content, read: false},
    ];

    this._push(incoming);

    const tools: ToolDef[] = [
      this._defShellTool(),
      this._defChatModeTool(),
    ];

    const release = await channelLock.waitForLock(15 * 60 * 1000);

    try {
      const messages = await this.runWithTools(fullMessageHistory, tools, (c) => this._execTool(c), 15);
      for (const message of messages) {
        this.context.push({
          ts: new Date().toISOString(),
          role: message.role === 'tool' ? message.role : (message.from === this.id ? "assistant" : "user"),
          from: message.from,
          content: message.content,
          read: true,
        });
      }

      const lastMessage = messages[messages.length - 1];

      if (lastMessage) {
        await this._deliver(lastMessage.content || lastMessage.reasoning || '');
      } else {
        console.error('lastMessage is undefined');
      }
    } finally {
      release();
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

      let content = isEmpty(msg.tool_calls ?? []) ? response : undefined;
      const recipient = tags[0]?.value;

      if (tags[0]?.kind === 'file') {
        content = `I am writing the following content\n\`\`\`\n${content}\n\`\`\`\n to file ${recipient}`;
      }

      if(msg.reasoning) messages.push({ role: "assistant", from: this.id, content: `<think>${msg.reasoning}</think>`, reasoning: msg.reasoning, read: true});
      if(msg.content && content) messages.push({ role: "assistant", from: this.id, content, reasoning: msg.reasoning, recipient, read: true});

      if (tags[0]?.kind === 'file') {
        this.fileToRedirectTo = recipient;
        const payload = (response ?? msg.content ?? '');
        const statusMsg = await this._deliver(payload);   // <-- get status
        messages.push(statusMsg);                         // <-- now the model sees it
        continue;
      }

      if ((!msg.tool_calls || msg.tool_calls.length === 0)) {
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
        return { ...await this._runShell(name, args), tool_call_id: call.id, role: "tool", name, from: this.id, read: false };
      }
      if (name === "chat_mode") {
        this._setAudience(String(args.mode ?? "group"));
        return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: true }), from: this.id, read: false };
      }

      // unknown tool
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: "unknown tool" }), from: this.id, read: false };
    } catch (err) {
      return { role: "tool", name, tool_call_id: call.id, content: JSON.stringify({ ok: false, err: String(err) }), from: this.id, read: false };
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
      const content =truncate(`Tool: ${functionName} Command: ${cmd} -> ` + JSON.stringify({ ok: code === 0, stdout, stderr, exit_code: code }), this.maxShellReponseCharacters);

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

// inside AgentModel
private async _deliver(msg: string): Promise<ChatMessage> {
  const kind   = this.fileToRedirectTo ? "file" : this.audience.kind;
  const target = this.fileToRedirectTo ? this.fileToRedirectTo : this.audience.target;

  let response: ChatMessage | undefined;

  try {
    switch (kind) {
      case "group": {
        await this.broadcast(msg);
        response = { ts: Date.now().toString(), from: this.id, content: msg, read: true, role: "assistant" };
        break;
      }
      case "direct": {
        await this.broadcast(msg, target);
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

        // append (not overwrite)
        if ((globalThis as any).Bun?.write) {
          await (globalThis as any).Bun.write(p, text + "\n", { create: true, append: true });
        } else {
          const fs = await import("fs");
          await fs.promises.appendFile(p, text + "\n", { encoding: "utf-8" });
        }

        response = {
          ts: Date.now().toString(),
          from: this.id,
          role: "tool",
          read: true,
          content: `\`\`\`${text}\`\`\`\n=> Written to file ${p}`
        };
        console.log(`******* wrote file ${p}`);
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
    console.error(`******* file write failed: ${e}`);
  } finally {
    if (this.fileToRedirectTo) this.audience = { kind: "group", target: "*" };
    this.fileToRedirectTo = undefined;
  }

  return response ?? { ts: Date.now().toString(), from: this.id, role: "system", read: true, content: "(deliver: no-op)" };
}
  private _push(msg: RoomMessage): void {
    this.context.push({
      ts: new Date().toISOString(),
      role: msg.role === 'tool' ? msg.role : (msg.from === this.id ? "assistant" : "user"),
      from: msg.from,
      content: msg.content,
      read: true,
    });
    while (this.context.length > this.maxMessagesInContext) this.context.shift();
  }
}
