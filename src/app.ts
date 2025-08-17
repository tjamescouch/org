/**
 * Minimal multi-agent round-robin demo with TagParser routing.
 * - Agents each get up to --max-tools tool calls per *turn*.
 * - If an agent returns a reply with no tool usage, it yields immediately.
 * - Router parses @agent / @group / #file tags and places DMs into per-agent inboxes.
 *
 * Run:
 *   bun run src/app.ts --agents "alice:mock,bob:mock" --max-tools 2
 */

import { MockModel } from "./agents/mock-model";
import { makeRouter } from "./app_support/route-with-tags";
import { Logger } from "./logger"

// Small color helpers
const C = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type ModelKind = "mock";

interface AgentRec {
  id: string;
  kind: ModelKind;
  model: MockModel;
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

function parseAgents(spec: string | undefined): AgentRec[] {
  if (!spec) return [];
  const list = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const out: AgentRec[] = [];
  for (const item of list) {
    const [id, kind = "mock"] = item.split(":");
    const k = (kind as ModelKind) || "mock";
    if (k !== "mock") throw new Error(`Unknown model kind "${k}"`);
    out.push({ id, kind: "mock", model: new MockModel(id) });
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
  const args = parseArgs((globalThis as any).Bun ? Bun.argv.slice(2) : process.argv.slice(2));
  const agents = parseAgents(args["agents"]);
  const maxTools = Math.max(0, Number(args["max-tools"] || 2));

  if (agents.length === 0) {
    console.error("No agents. Use --agents \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const usersFirstPrompt = await readPrompt("Prompt> ");

  // Router around TagParser (feeds agent inboxes)
  const agentIds = agents.map((a) => a.id);
  const router = makeRouter(
    agentIds,
    // sendTo
    (recipient, from, content) => {
      ensureInbox(recipient).push(content);
      console.log(`${C.gray(`${from} → @${recipient}`)}: ${content}`);
    },
    // broadcast
    (from, content) => {
      for (const id of agentIds) if (id !== from) ensureInbox(id).push(content);
      console.log(`${C.gray(`${from} → @group`)}: ${content}`);
    },
    // onFile
    (from, filename, content) => {
      console.log(C.bold(C.gray(`[file from ${from}] #${filename}`)));
      console.log(content);
    }
  );

  // Helper: route the agent's final assistant text
  function routeAssistantText(from: string, text: string) {
    const parts = router.route(from, text);
    if (!parts.length) {
      // Treat as group when there are no tags
      for (const id of agentIds) if (id !== from) ensureInbox(id).push(text);
      console.log(`${C.gray(`${from} → @group`)}: ${text}`);
    }
  }

  // Round-robin until the system is idle for 2 consecutive rounds
  let idleRounds = 0;
  let cycle = 0;

  while (true) {
    cycle++;
    let anyWork = false;

    for (const a of agents) {
      let remaining = maxTools;
      // Prompt for this agent: consume inbox first, else user prompt
      const basePrompt = nextPromptFor(a.id, usersFirstPrompt);

      // Keep asking model while it wants to spend tools
      for (let hop = 0; hop < Math.max(1, maxTools + 1); hop++) {
        const peers = agents.map((x) => x.id);
        const reply = await a.model.respond(basePrompt, remaining, peers);

        if (reply.toolsUsed > 0) {
          // Simulate tool usage message
          console.log(`${C.cyan(`${a.id}:`)} $ tool → ${new Date().toISOString()}`);
          remaining = Math.max(0, remaining - reply.toolsUsed);
          anyWork = true;
          // After tool step, route whatever text the mock emitted this hop
          if (reply.message && reply.message.trim()) {
            routeAssistantText(a.id, reply.message.trim());
          }
          if (remaining <= 0) {
            console.log(`${C.cyan(`${a.id}:`)} (tool budget exhausted)`);
            break; // yield
          }
          // Continue loop to allow more tools if the model wants
          // (mock uses at most one per hop)
        } else {
          // No tools needed → yield after routing the text
          const msg = reply.message?.trim() || "Okay. (no tools needed)";
          console.log(`${C.cyan(`${a.id}:`)} ${msg}`);
          routeAssistantText(a.id, msg);
          break;
        }
      }
    }

    // Idle detection
    const pending = Array.from(inbox.values()).reduce((n, q) => n + q.length, 0);
    if (!anyWork && pending === 0) {
      idleRounds++;
    } else {
      idleRounds = 0;
    }

    if (idleRounds >= 2) { 
      Logger.warn(`Idel for ${idleRounds} rounds`);

      await sleep(1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
