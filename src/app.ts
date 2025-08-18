#!/usr/bin/env bun

import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { InputController } from "./input";
import { makeLmStudioOpenAiDriver } from "./drivers/openai-lmstudio";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";

/** ---------- CLI parsing ---------- */
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.split("=", 2);
      if (v !== undefined) out[k.slice(2)] = v;
      else key = k.slice(2);
    } else if (key) {
      out[key] = a; key = null;
    }
  }
  if (key) out[key] = true;
  return out;
}

function enableDebugIfRequested(args: Record<string, string | boolean>) {
  if (args["debug"] || process.env.DEBUG) {
    process.env.DEBUG = String(args["debug"] ?? process.env.DEBUG ?? "1");
    Logger.info("[DBG] debug logging enabled");
  }
}

function setupProcessGuards() {
  const dbgOn = !!process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false";
  if (dbgOn) {
    process.on("beforeExit", (code) => {
      Logger.info("[DBG] beforeExit", code, "— scheduler stays alive unless Ctrl+C");
      // schedule a no-op to avoid accidental early exit if the event loop is empty
      setTimeout(() => {}, 60_000);
    });
    process.on("uncaughtException", (e) => { Logger.info("[DBG] uncaughtException:", e); });
    process.on("unhandledRejection", (e) => { Logger.info("[DBG] unhandledRejection:", e); });
    process.stdin.on("end", () => Logger.info("[DBG] stdin end"));
    process.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
    process.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));


  }
}

/** ---------- Mode / safety ---------- */
function computeMode(): { interactive: boolean; safe: boolean } {
  const interactive = true; // scheduler + hotkey assumes interactive
  const cfg = loadConfig();
  const safe = !!(cfg as any)?.runtime?.safe;
  ExecutionGate.configure({ safe, interactive });
  return { interactive, safe };
}

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: any };

function parseAgents(
  spec: string | undefined,
  llmDefaults: { model: string; baseUrl: string; protocol: "openai"; apiKey?: string }
): AgentSpec[] {
  const list = String(spec || "").split(",").map(x => x.trim()).filter(Boolean);
  if (list.length === 0) {
    return [
      { id: "alice", kind: "lmstudio", model: new LlmAgent("alice", 
      makeLmStudioOpenAiDriver({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: (llmDefaults as any).apiKey
      })
      ,llmDefaults.model) },
      { id: "bob",   kind: "lmstudio", model: new LlmAgent("bob",
      makeLmStudioOpenAiDriver({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: (llmDefaults as any).apiKey
      })
      ,llmDefaults.model) }
    ];
  }
  const out: AgentSpec[] = [];
  for (const item of list) {
    const [id, kindRaw = "mock"] = item.split(":");
    const kind = (kindRaw as ModelKind) || "mock";
    if (kind === "mock") {
      out.push({ id, kind, model: new MockModel(id) });
    } else if (kind === "lmstudio") {
      if (llmDefaults.protocol !== "openai") throw new Error(`Unsupported protocol: ${llmDefaults.protocol}`);
      const driver = makeLmStudioOpenAiDriver({
        baseUrl: llmDefaults.baseUrl,
        model: llmDefaults.model,
        apiKey: (llmDefaults as any).apiKey
      });
      out.push({ id, kind, model: new LlmAgent(id, driver, llmDefaults.model) as any });
    } else {
      throw new Error(`Unknown model kind: ${kindRaw}`);
    }
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as any).Bun ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);
  enableDebugIfRequested(args);
  setupProcessGuards();

  const maxTools = Math.max(0, Number(args["max-tools"] || 20));
  computeMode();

  const agentSpecs = parseAgents(String(args["agents"] || ""), cfg.llm);
  if (agentSpecs.length === 0) {
    Logger.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[]) => a.model.respond(prompt, budget, peers)
  }));

  // Wiring: scheduler + input
  let input!: InputController;
  const scheduler = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: async (from, content) => {
      if (process.env.DEBUG) Logger.info(`[DBG] @@user requested by ${from}:`, JSON.stringify(content));
      return await input.provideToScheduler(from, content);
    }
  });

  input = new InputController(scheduler);
  input.init();

  if (process.env.DEBUG) {
    Logger.info("[DBG] Agents:", agents.map(a => a.id).join(", "));
    Logger.info("[DBG] maxTools:", maxTools);
  }

  // Kick off with an initial user prompt
  await input.askInitialAndSend(args['prompt']);

  // Never return under normal operation; exit only on Ctrl+C
  await scheduler.start();
}

main().catch((e) => {
  Logger.info(e);
  process.exit(1);
});
