// [patch:run-modes] BEGIN
import { ExecutionGate } from "./tools/execution-gate";
import { FileWriter } from "./io/file-writer"; // add this import near the top

// Mode detection:
// - Shell mode (non-interactive) when --prompt is provided OR stdin is piped (and "-" not used).
// - Interactive when "-" provided as a positional OR when "--safe" is used without --prompt.
// Additionally: SAFE + non-interactive is invalid (enforced by ExecutionGate.configure).

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function getFlagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}
function isStdinPiped(): boolean {
  try { return !process.stdin.isTTY; } catch { return false; }
}
function wantsInteractiveByDash(): boolean {
  return process.argv.includes("-");
}
function computeMode(): { interactive: boolean; prompt?: string; safe: boolean } {
  const safe = hasFlag("--safe") || /^(1|true|yes)$/i.test(String(process.env.SAFE_MODE || ""));
  const promptArg = getFlagValue("--prompt");
  const dashInteractive = wantsInteractiveByDash();
  const stdinPiped = isStdinPiped();

  let interactive: boolean;
  if (dashInteractive) {
    interactive = true;
  } else if (promptArg || (stdinPiped && !dashInteractive)) {
    interactive = false; // shell mode
  } else if (safe && !promptArg) {
    interactive = true; // `org --safe` → interactive
  } else {
    interactive = true; // default interactive
  }

  const prompt = promptArg;
  // Configure the ExecutionGate once (throws if invalid combo)
  ExecutionGate.configure({ interactive, safe });

  return { interactive, prompt, safe };
}

// Expose mode for the rest of app.ts if needed
const __APP_MODE = computeMode();
// [patch:run-modes] END
/**
 * Minimal multi-agent round-robin demo with TagParser routing.
 * Now supports an LM Studio driver via OpenAI protocol and a safe "sh" tool.
 */

import { makeRouter } from "./routing/route-with-tags";
import { TagParser } from "./utils/tag-parser";
import { MockModel } from "./agents/mock-model";
import { LlmAgent } from "./agents/llm-agent";
import { loadConfig } from "./config";
import { makeLmStudioOpenAiDriver } from "./drivers/openai-lmstudio";
import { Logger } from "./logger";
import { extractCodeGuards } from "./utils/extract-code-blocks";

export const C = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,   // <-- fixed here
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: any };

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  const rest: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.split("=", 2);
      if (v !== undefined) out[k.slice(2)] = v;
      else key = k.slice(2);
    } else if (key) {
      out[key] = a; key = null;
    } else {
      rest.push(a);
    }
  }
  if (key) out[key] = true;
  out["_"] = rest.join(" ");
  return out;
}

function parseAgents(s: string | undefined, llmDefaults: any): AgentSpec[] {
  const list = String(s || "").split(",").map(x => x.trim()).filter(Boolean);
  if (list.length === 0) {
    // default two mock agents, for demo
    return [
      { id: "alice", kind: "mock", model: new MockModel("alice") },
      { id: "bob",   kind: "mock", model: new MockModel("bob") },
    ];
  }
  const out: AgentSpec[] = [];
  for (const item of list) {
    const [id, kindRaw = "mock"] = item.split(":");
    const kind = (kindRaw as ModelKind) || "mock";

    if (kind === "mock") {
      out.push({ id, kind, model: new MockModel(id) as any });
      continue;
    }

    if (kind === "lmstudio") {
      if (llmDefaults.protocol !== "openai") {
        throw new Error(`Unsupported protocol "${llmDefaults.protocol}" for driver lmstudio`);
      }
      const driver = makeLmStudioOpenAiDriver({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: llmDefaults.apiKey
      });
      out.push({ id, kind, model: new LlmAgent(id, driver, llmDefaults.model) as any });
      continue;
    }

    throw new Error(`Unknown model kind "${kindRaw}"`);
  }
  return out;
}

// Simple line reader for a one-time prompt:
async function readPrompt(question = "user: "): Promise<string> {
  const rl = await import("readline");
  return new Promise<string>((resolve) => {
    const rli = rl.createInterface({ input: process.stdin, output: process.stdout });
    rli.question(question, (ans) => {
      rli.close();
      resolve(ans || "");
    });
  });
}

// Inboxes for DMs/broadcasts parsed from tags.
const inbox = new Map<string, string[]>();
function ensureInbox(id: string) {
  if (!inbox.has(id)) inbox.set(id, []);
  return inbox.get(id)!;
}

let lastUserDMTarget: string | null = null; // set when an agent addresses @@user

function hasUserInInbox(): boolean {
  return ensureInbox("user").length > 0;
}

function nextPromptFor(id: string, fallback: string): string {
  const q = ensureInbox(id);
  if (q.length > 0) {
    return q.splice(0, q.length).join("\n");
  }
  return fallback;
}

async function main() {
  const cfg = loadConfig();
  const argv = (globalThis as any).Bun ? Bun.argv.slice(2) : process.argv.slice(2);
  const args = parseArgs(argv);

  const agents = parseAgents(args["agents"], cfg.llm);
  const maxTools = Math.max(0, Number(args["max-tools"] || 20));

  if (agents.length === 0) {
    console.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const argPrompt = args["prompt"] || undefined;

  const usersFirstPrompt = argPrompt || await readPrompt("user: ");

  // Router using TagParser (feeds agent inboxes)
  const agentIds = agents.map((a) => a.id);
  const router = makeRouter({
    // direct message to a specific agent: @@<agent>
    onAgent: (from, to, content) => {
      ensureInbox(to).push(content);
      Logger.debug(`${C.gray(`${from} → @@${to}`)}: ${content}`);
    },
    // broadcast to all agents except sender: @@group (or plain text preamble)
    onGroup: (from, content) => {
      for (const id of agentIds) if (id !== from) ensureInbox(id).push(content);
      Logger.debug(`${C.gray(`${from} → @@group`)}: ${content}`);
    },
    // address the human user: @@user — capture who asked so that the next user reply DMs them by default
    onUser: (from, content) => {
      lastUserDMTarget = from;
      // Put a lightweight marker so the scheduler yields control to the user prompt.
      ensureInbox("user").push(content);
      Logger.debug(`${C.gray(`${from} → @@user`)}: ${content}`);
    },
    // onFile: ##<name> <content> — offer to write a file, gated by ExecutionGate
    onFile: async (from, filename, content) => {
      const cmd = `${content}\n***** Write to file? [y/N] ${filename}\n`;
      const sanitizedContent = extractCodeGuards(content).cleaned;

      try {
        await ExecutionGate.gate(cmd);
      } catch (e) {
        const msg = `Execution denied by guard or user: ${cmd}`;
        console.log(C.red(`sh: ${cmd} -> ${msg}`));
        throw e;
      }

      Logger.warn(C.bold(C.gray(`[file from ${from}] ##${filename}`)));
      Logger.warn(content);

      // actually write the file
      try {
        const result = await FileWriter.write(filename, sanitizedContent);
        Logger.info(C.green(`wrote ${result.path} (${result.bytes} bytes)`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Logger.error(C.red(`failed to write ${filename}: ${msg}`));
      }
    }
  });

  function routeMessage(from: string, text: string) {
    const parts = TagParser.parse(text);
    if (parts.length === 0) {
      if (from === "user" && lastUserDMTarget) {
        ensureInbox(lastUserDMTarget).push(text);
        console.log(`${C.gray(`${from} → @@${lastUserDMTarget}`)}: ${text}`);
      } else {
        for (const id of agentIds) if (id !== from) ensureInbox(id).push(text);
        console.log(`${C.gray(`${from} → @@group`)}: ${text}`);
      }
      return;
    }
    router(from, text);
  }

  function isThereAUserMessageInAnInbox(): boolean {
    // Any agent has asked @@user recently; we track a lightweight inbox entry for the user.
    return hasUserInInbox();
  }

  // Round-robin until idle for two consecutive rounds
  let idleRounds = 0;

  while (true) {
    let anyWork = false;

    for (const a of agents) {
      const basePrompt = nextPromptFor(a.id, usersFirstPrompt);

      // Keep asking model while it wants to spend tools
      for (let hop = 0; hop < Math.max(1, maxTools + 1); hop++) {
        const peers = agents.map((x) => x.id);
        const reply = await a.model.respond(basePrompt, 1, peers);
        let remaining = maxTools;

        if (TagParser.parse(reply.message).some(t => t.kind === "user") || isThereAUserMessageInAnInbox()) {
          const msg = reply.message?.trim() || "Yielding to user.";
          console.log(`${C.cyan(`${a.id}:`)} ${msg}`);

          const userMessage = await readPrompt("user: ");
          routeMessage("user", userMessage);
          // clear user inbox marker(s) now that we received input
          ensureInbox("user").length = 0;

          break;
        }

        if (reply.toolsUsed > 0) {
          console.log(`${C.cyan(`${a.id}:`)} $ tool ${reply.toolsUsed} → ${new Date().toISOString()}`);
          remaining = Math.max(0, remaining - reply.toolsUsed);
          anyWork = true;
          if (reply.message && reply.message.trim()) {
            routeMessage(a.id, reply.message.trim());
          }
          if (remaining <= 0) {
            console.log(`${C.cyan(`${a.id}:`)} (tool budget exhausted)`);
            break; // yield
          }
        } else {
          const msg = reply.message?.trim() || "Okay. (no tools needed)";
          console.log(`${C.cyan(`${a.id}:`)} ${msg}`);
          routeMessage(a.id, msg);
          break; // yield when no tools requested
        }
      }
    }

    const pending = Array.from(inbox.values()).reduce((n, q) => n + q.length, 0);
    if (!anyWork && pending === 0) {
      idleRounds++;
    } else {
      idleRounds = 0;
    }
    if (idleRounds >= 2) break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

