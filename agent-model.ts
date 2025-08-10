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
  private maxShellReponseCharacters: number = 50_000;
  private maxMessagesInContext = 10;

  constructor(id: string) {
    super(id);
  }

  /* ------------------------------------------------------------ */
  async initialMessage(incoming: RoomMessage): Promise<void> {
    this._push(incoming);
    console.log(`\n\n**** ${this.id}:\n${incoming.content}`);

    await this.broadcast(incoming.content);
  }

  async receiveMessage(incoming: RoomMessage): Promise<void> {

    const system = `You are agent "${this.id}".
If you need to run shell commands, call the sh tool. 
Commands are executed in a Debian VM.
To chat directly to another agent use the chat_mode tool. 
Examples: group, direct:bob - to talk to the group or directly to bob respectively.
Try to make decisions for yourself even if you're not completely sure that they are correct.
You have access to an actual Debian VM.
It has git and bun installed.

You have the unix 'patch' command:

Usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]

Input options:

  -p NUM  --strip=NUM  Strip NUM leading components from file names.
  -F LINES  --fuzz LINES  Set the fuzz factor to LINES for inexact matching.
  -l  --ignore-whitespace  Ignore white space changes between patch and input.

  -c  --context  Interpret the patch as a context difference.
  -e  --ed  Interpret the patch as an ed script.
  -n  --normal  Interpret the patch as a normal difference.
  -u  --unified  Interpret the patch as a unified difference.

  -N  --forward  Ignore patches that appear to be reversed or already applied.
  -R  --reverse  Assume patches were created with old and new files swapped.

  -i PATCHFILE  --input=PATCHFILE  Read patch from PATCHFILE instead of stdin.

Output options:

  -o FILE  --output=FILE  Output patched files to FILE.
  -r FILE  --reject-file=FILE  Output rejects to FILE.

  -D NAME  --ifdef=NAME  Make merged if-then-else output using NAME.
  --merge  Merge using conflict markers instead of creating reject files.
  -E  --remove-empty-files  Remove output files that are empty after patching.

  -Z  --set-utc  Set times of patched files, assuming diff uses UTC (GMT).
  -T  --set-time  Likewise, assuming local time.

  --quoting-style=WORD   output file names using quoting style WORD.
    Valid WORDs are: literal, shell, shell-always, c, escape.
    Default is taken from QUOTING_STYLE env variable, or 'shell' if unset.

Backup and version control options:

  -b  --backup  Back up the original contents of each file.
  --backup-if-mismatch  Back up if the patch does not match exactly.
  --no-backup-if-mismatch  Back up mismatches only if otherwise requested.

  -V STYLE  --version-control=STYLE  Use STYLE version control.
	STYLE is either 'simple', 'numbered', or 'existing'.
  -B PREFIX  --prefix=PREFIX  Prepend PREFIX to backup file names.
  -Y PREFIX  --basename-prefix=PREFIX  Prepend PREFIX to backup file basenames.
  -z SUFFIX  --suffix=SUFFIX  Append SUFFIX to backup file names.

  -g NUM  --get=NUM  Get files from RCS etc. if positive; ask if negative.

Miscellaneous options:

  -t  --batch  Ask no questions; skip bad-Prereq patches; assume reversed.
  -f  --force  Like -t, but ignore bad-Prereq patches, and assume unreversed.
  -s  --quiet  --silent  Work silently unless an error occurs.
  --verbose  Output extra information about the work being done.
  --dry-run  Do not actually change any files; just print what would happen.
  --posix  Conform to the POSIX standard.

  -d DIR  --directory=DIR  Change the working directory to DIR first.
  --reject-format=FORMAT  Create 'context' or 'unified' rejects.
  --binary  Read and write data in binary mode.
  --read-only=BEHAVIOR  How to handle read-only input files: 'ignore' that they
                        are read-only, 'warn' (default), or 'fail'.

  -v  --version  Output version info.
  --help  Output this help.

You have access to basic unix commands. There is no unix command called apply_patch nor is there a tool with that name.
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
PLEASE use the file system.
PLEASE stream files to disk rather than just chatting about them with the group.
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
DO NOT PUSH ANYTHING TO GITHUB.
Be concise.


`;

    const fullMessageHistory: ChatMessage[] = [
      { role: "system", from: "System", content: system, read: false},
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
  const responses: ChatMessage = [];

  for (let i = 0; i < maxHops; i++) {
    const msg = await chatOnce(this.id, messages.concat(responses), { tools, tool_choice: "auto", num_ctx: 128000 }) ?? { content: "Error" };

    // Parse tags; TagParser returns { clean, tags }, where each tag has its own content slice.
    const { clean: response, tags } = TagParser.parse(msg.content || "");

    // Visible assistant text for this turn (only when not issuing tool calls)
    const visibleContent = isEmpty(msg.tool_calls ?? []) ? response : undefined;

    // Preserve assistant's chain-of-thought wrapper if present
    if (msg.reasoning) {
      responses.push({
        role: "assistant",
        from: this.id,
        content: `<think>${msg.reasoning}</think>`,
        reasoning: msg.reasoning,
        read: true,
      });
    }

    // Push the visible assistant message (cleaned text w/o tags) if any
    if (msg.content && visibleContent !== undefined) {
      responses.push({
        role: "assistant",
        from: this.id,
        content: visibleContent,
        reasoning: msg.reasoning,
        read: true,
      });
    }

    // --- Handle ALL tags (multiple) ----------------------------------------
    if (tags.length > 0) {
      // Save current audience so we can restore after agent-directed deliveries
      const savedAudience = { ...this.audience };

      for (const t of tags) {
        if (t.kind === "file") {
          // Redirect _deliver to file; use this tag's content verbatim (no whitespace mangling)
          this.fileToRedirectTo = t.value;
          const statusMsg = await this._deliver(t.content ?? "");
          // Ensure the LLM sees success/error on next hop
          if (statusMsg) responses.push(statusMsg);
          // _deliver will restore audience and clear fileToRedirectTo
        } else if (t.kind === "agent") {
          // Temporarily deliver directly to the tagged agent via _deliver
          this.audience = { kind: "direct", target: t.value };
          const delivered = await this._deliver(t.content ?? "");
          if (delivered) responses.push(delivered);
          // restore audience after each agent delivery
          this.audience = { ...savedAudience };
        }
      }
      continue;
    }
    // -----------------------------------------------------------------------

    // If no tool calls were requested, return accumulated messages
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return responses;
    }

    // Execute tool calls and append results
    for (const call of msg.tool_calls) {
      const toolMsg = await execTool(call);
      responses.push(toolMsg);
    }
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
      const args = JSON.parse(call.function.arguments || {cmd: ''});

      if (name === "sh") {
        return { ...await this._runShell(name, {...args, rawCmd: args.cmd }), tool_call_id: call.id, role: "tool", name, from: this.id, read: false };
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
  private async _runShell(functionName: string, { cmd, rawCmd }: { cmd: string, rawCmd?: string }): Promise<{role: string, name: string, content: string}> {

    const timeout = Math.max(1, Math.min(30, Number(this.shellTimeout)));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (timeout + 1) * 1000);

    try {
      const sanitizedCmd = cmd.replaceAll('apply_patch', 'patch');
      const proc = Bun.spawn(["sh", "-c", sanitizedCmd], { stdout: "pipe", stderr: "pipe", signal: ac.signal });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const content =truncate(`${ functionName ? `Tool ${functionName}: ` : '' } Command: '${sanitizedCmd ?? rawCmd ?? cmd}' -> ` + JSON.stringify({ ok: code === 0, stdout, stderr, exit_code: code }), this.maxShellReponseCharacters);

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

        // overwrite
        if ((globalThis as any).Bun?.write) {
          await (globalThis as any).Bun.write(p, text + "\n", { create: true, append: false });
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
    this.cleanContext();
  }

  private cleanContext() {
    while (this.context.length > this.maxMessagesInContext) this.context.shift();
  }
}
