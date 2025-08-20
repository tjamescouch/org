#!/usr/bin/env bun
// src/app.ts

import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { InputController } from "./input/controller";
import { makeLmStudioOpenAiDriver } from "./drivers/openai-lmstudio";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";

/** ---------- CLI parsing ---------- */
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (typeof v === "string") out[k] = v;
      else { key = k; out[k] = true; }
    } else if (key) {
      out[key] = a; key = null;
    } else {
      // positional: treat as --prompt if not yet set
      if (!("prompt" in out)) out["prompt"] = a;
      else out[`arg${Object.keys(out).length}`] = a;
    }
  }
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
  const interactive = true; // interactive controller + hotkeys
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
  const list = String(spec || "alice:lmstudio").split(",").map(x => x.trim()).filter(Boolean);
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

  const agentSpecs = parseAgents(String(args["agents"] || "alice:lmstudio"), cfg.llm);
  if (agentSpecs.length === 0) {
    Logger.error("No agents. Use --agents \"alice:lmstudio,bob:mock\" or \"alice:mock,bob:mock\"");
    process.exit(1);
  }

  const agents = agentSpecs.map(a => ({
    id: a.id,
    // Pass-through to the agent/model's respond method
    respond: (prompt: string, budget: number, peers: string[], draining: () => boolean) =>
      (a.model as any).respond(prompt, budget, peers, draining),
    guardOnIdle: (state: any) => (a.model as any).guardOnIdle?.(state) ?? null,
    guardCheck: (route: any, content: string, peers: string[]) =>
      (a.model as any).guardCheck?.(route, content, peers) ?? null,
  }));

  // Wiring: controller + scheduler
  const input = new InputController({
    interjectKey: String(args["interject-key"] || "i"),
    interjectBanner: String(args["banner"] || "You: "),
  });

  const scheduler = new RoundRobinScheduler({
    agents,
    maxTools,
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
  });

  input.attachScheduler(scheduler);

  if (process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false") {
    Logger.info("[DBG] agents:", agents.map(a => a.id).join(", "));
    Logger.info("[DBG] maxTools:", maxTools);
  }

  // Kick off with an initial user prompt
  const promptArg = ((): string | boolean | undefined => {
    if (args["prompt"] === true) return true;       // --prompt
    if (typeof args["prompt"] === "string") return args["prompt"];
    return undefined;
  })();
  await input.askInitialAndSend(promptArg);

  // Never returns in normal operation; exit only via Ctrl+C
  await scheduler.start();
}

main().catch((e) => {
  Logger.info(e);
  process.exit(1);
});
