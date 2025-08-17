/**
 * Minimal multi-agent round-robin demo with TagParser routing.
 * Now supports an LM Studio driver via OpenAI protocol and a safe "sh" tool.
 */

import { makeRouter } from "./app_support/route-with-tags";
import { TagParser } from "./utils/tag-parser";
import { MockModel } from "./agents/mock-model";
import { LlmAgent } from "./agents/llm-agent";
import { loadConfig } from "./config";
import { makeLmStudioOpenAiDriver } from "./drivers/openai-lmstudio";
import { ExecutionGate } from "./tools/exec-gate";
import { Logger } from "./logger";

// Small color helpers
const C = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type ModelKind = "mock" | "lmstudio";

interface AgentRec {
  id: string;
  kind: ModelKind;
  model: { respond(prompt: string, maxTools: number, peers: string[]): Promise<{message: string; toolsUsed: number}> };
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
      out[key] = val;
    }
  }
  return out;
}

function parseAgents(spec: string | undefined, llmDefaults: { driver: "lmstudio"; model: string; baseUrl: string; protocol: "openai"; }): AgentRec[] {
  if (!spec) return [];
  const list = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const out: AgentRec[] = [];

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
      });
      out.push({ id, kind, model: new LlmAgent(id, driver, llmDefaults.model) as any });
      continue;
    }

    throw new Error(`Unknown model kind "${kindRaw}"`);
  }
  return out;
}

// Simple line reader for a one-time prompt:
async function readPrompt(question = "Prompt> "): Promise<string> {
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

  // Configure the execution gate (safe confirmation)
  ExecutionGate.configure({ safe: cfg.runtime.safe });

  const agents = parseAgents(args["agents"], cfg.llm);
  const maxTools = Math.max(0, Number(args["max-tools"] || 20));

  if (agents.length === 0) {
    console.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const usersFirstPrompt = args["prompt"] || await readPrompt("Prompt> ");

  // Router using TagParser (feeds agent inboxes)
  const agentIds = agents.map((a) => a.id);
  const router = makeRouter(
    agentIds,
    // sendTo
    (recipient, from, content) => {
      ensureInbox(recipient.toLowerCase()).push(content);
      Logger.debug(`${C.gray(`${from} → @${recipient}`)}: ${content}`);
    },
    // broadcast
    (from, content) => {
      for (const id of agentIds) if (id !== from) ensureInbox(id.toLowerCase()).push(content);
      Logger.debug(`${C.gray(`${from} → @group`)}: ${content}`);
    },
    // onFile
    (from, filename, content) => {
      Logger.warn(C.bold(C.gray(`[file from ${from}] #${filename}`)));
      Logger.warn(content);
    }
  );

  function routeAssistantText(from: string, text: string) {
    const parts = new TagParser().parse(text);
    if (parts.length === 0) {
      for (const id of agentIds) if (id !== from) ensureInbox(id).push(text);
      console.log(`${C.gray(`${from} → @group`)}: ${text}`);
      return;
    }
    router.route(from, text);
  }

  // Round-robin until idle for two consecutive rounds
  let idleRounds = 0;

  while (true) {
    let anyWork = false;

    for (const a of agents) {
      let remaining = maxTools;
      const basePrompt = nextPromptFor(a.id, usersFirstPrompt);

      // Keep asking model while it wants to spend tools
      for (let hop = 0; hop < Math.max(1, maxTools + 1); hop++) {
        const peers = agents.map((x) => x.id);
        const reply = await a.model.respond(basePrompt, remaining, peers);

        if (reply.toolsUsed > 0) {
          console.log(`${C.cyan(`${a.id}:`)} $ tool → ${new Date().toISOString()}`);
          remaining = Math.max(0, remaining - reply.toolsUsed);
          anyWork = true;
          if (reply.message && reply.message.trim()) {
            routeAssistantText(a.id, reply.message.trim());
          }
          if (remaining <= 0) {
            console.log(`${C.cyan(`${a.id}:`)} (tool budget exhausted)`);
            break; // yield
          }
        } else {
          const msg = reply.message?.trim() || "Okay. (no tools needed)";
          console.log(`${C.cyan(`${a.id}:`)} ${msg}`);
          routeAssistantText(a.id, msg);
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
