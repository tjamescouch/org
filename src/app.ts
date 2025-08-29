#!/usr/bin/env bun
// src/app.ts

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync, spawn } from "child_process";

import { R } from "./runtime/runtime";
import { ExecutionGate } from "./tools/execution-gate";
import { loadConfig } from "./config/config";
import { Logger } from "./logger";
import { RoundRobinScheduler } from "./scheduler";
import { LlmAgent } from "./agents/llm-agent";
import { MockModel } from "./agents/mock-model";
import { makeStreamingOpenAiLmStudio } from "./drivers/streaming-openai-lmstudio";
import { getRecipe } from "./recipes";
import { installTtyGuard, withCookedTTY } from "./input/tty-guard";
import { ReviewManager } from "./scheduler/review-manager";
import { sandboxMangers } from "./sandbox/session";
import { SchedulerLike, TtyController } from "./input/tty-controller";
import Passthrough from "./input/passthrough";

type InputPort = {
  askUser(fromAgent: string, content: string): Promise<void>;
  setScheduler(s: unknown): void;
  start(): void;
  close?(graceful?: boolean): Promise<void>;
};

installTtyGuard();

/* … keep your helpers exactly as you posted … (parseArgs, resolveProjectDir, etc.) */
/* For brevity here, I’m leaving those unchanged — paste over your current file and keep them. */

async function main() {
  const cfg = loadConfig();
  const argv = ((globalThis as any).Bun ? Bun.argv.slice(2) : R.argv.slice(2));
  const args = (function parseArgs(argv: string[]) {
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
        if (!("prompt" in out)) out["prompt"] = a;
        else out[`arg${Object.keys(out).length}`] = a;
      }
    }
    return out;
  })(argv);

  /* … tmux handoff / debug guards / recipe loading … keep as-is … */

  // Build agents
  const agentSpecs = (function parseAgents(
    spec: string | undefined,
    llmDefaults: { model: string; baseUrl: string; protocol: "openai"; apiKey?: string },
    recipeSystemPrompt?: string | null
  ) {
    const list = String(spec || "alice:lmstudio").split(",").map(x => x.trim()).filter(Boolean);
    const out: { id: string; kind: "mock" | "lmstudio"; model: any }[] = [];
    for (const item of list) {
      const [id, kindRaw = "mock"] = item.split(":");
      const kind = (kindRaw as "mock" | "lmstudio") || "mock";
      if (kind === "mock") {
        const m = new MockModel(id);
        out.push({ id, kind, model: m });
      } else if (kind === "lmstudio") {
        const driver = makeStreamingOpenAiLmStudio({
          baseUrl: cfg.llm.baseUrl,
          model: cfg.llm.model,
          apiKey: (cfg.llm as any).apiKey
        });
        const agentModel = new LlmAgent(id, driver, cfg.llm.model) as any;
        if (recipeSystemPrompt && typeof agentModel.setSystemPrompt === "function") {
          agentModel.setSystemPrompt(recipeSystemPrompt);
        }
        out.push({ id, kind, model: agentModel });
      }
    }
    return out;
  })(String(args["agents"] || "alice:lmstudio"), cfg.llm, getRecipe(null)?.system ?? null);

  const agents = agentSpecs.map(a => ({
    id: a.id,
    respond: (prompt: string, budget: number, peers: string[], cb: () => boolean) => a.model.respond(prompt, budget, peers, cb),
    guardOnIdle: (state: any) => a.model.guardOnIdle?.(state) ?? null,
    guardCheck: (route: any, content: string, peers: string[]) => a.model.guardCheck?.(route, content, peers) ?? null,
  }));

  // Compute kickoff first to set promptEnabled correctly
  const recipe = getRecipe(null);
  const kickoff: string | undefined =
    typeof args["prompt"] === "string" ? String(args["prompt"])
    : typeof recipe?.kickoff === "string" ? recipe!.kickoff
    : undefined;

  let input!: InputPort;
  const reviewMode = (args["review"] ?? "ask") as "ask" | "auto" | "never";
  const scheduler: SchedulerLike = new RoundRobinScheduler({
    agents,
    maxTools: Math.max(0, Number(args["max-tools"] ?? (recipe?.budgets?.maxTools ?? 20))),
    onAskUser: (fromAgent: string, content: string) => input.askUser(fromAgent, content),
    projectDir: (function () {
      // resolveProjectDir (inline for brevity)
      try {
        const out = execFileSync("git", ["-C", R.cwd(), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
        if (out) return out;
      } catch {}
      return R.cwd();
    })(),
    reviewMode,
    promptEnabled:
      typeof args["prompt"] === "boolean"
        ? (args["prompt"] as boolean)
        : kickoff ? false : R.stdin.isTTY,
  });

  // ---- TRACE WRAPPERS (only logs when ORG_TRACE=1) ----
  if (process.env.ORG_TRACE === "1") {
    const wrap = (obj: any, name: string) => {
      const orig = obj[name]?.bind(obj);
      obj[name] = async (...a: any[]) => {
        Logger.info(`[TRACE] app.${name}.called`, a.length ? a[0] : undefined);
        try {
          const r = await orig?.(...a);
          Logger.info(`[TRACE] app.${name}.done`);
          return r;
        } catch (e) {
          Logger.info(`[TRACE] app.${name}.error`, (e as any)?.message || e);
          throw e;
        }
      };
    };
    wrap(scheduler as any, "enqueueUserText");
    wrap(scheduler as any, "enqueue");
    wrap(scheduler as any, "send");
    wrap(scheduler as any, "start");
  }
  // ---------------------------------------

  // Build input
  if (R.stdin.isTTY) {
    input = new TtyController({
      waitOverlayMessage: "Waiting for agent to finish",
      waitSuppressOutput: true,
      stdin: R.stdin,
      stdout: R.stdout,
      prompt: String(args["banner"] ?? "User: "),
      interjectKey: String(args["interject-key"] ?? "i"),
      interjectBanner: String(args["banner"] ?? "You: "),
      finalizer: async () => { /* finalize via scheduler in main finally */ },
    });
  } else {
    input = new Passthrough({
      stdin: R.stdin,
      stdout: R.stdout,
      scheduler,
      finalizer: async () => { /* finalize via scheduler in main finally */ },
    });
  }

  input.setScheduler(scheduler as any);
  input.start();
  if (process.env.ORG_TRACE === "1") {
    Logger.info(`[TRACE] app.input.started`, { tty: (R.stdin as any).isTTY });
  }

  // Seed kickoff (if provided)
  if (typeof kickoff === "string" && kickoff.length > 0) {
    if ((scheduler as any).enqueueUserText) {
      Logger.info(`[TRACE] app.enqueueUserText(kickoff)`, kickoff);
      await (scheduler as any).enqueueUserText(kickoff);
    } else if ((scheduler as any).enqueue) {
      Logger.info(`[TRACE] app.enqueue(kickoff)`, kickoff);
      await (scheduler as any).enqueue({ role: "user", content: kickoff });
    }
  }

  // Start the loop
  await (scheduler as any).start();

  // Finalize (non-interactive end or Ctrl+C path)
  try {
    await (scheduler as any).drain?.();
  } catch {}
}

main().catch((e) => {
  Logger.info(e);
  R.exit(1);
});
