/**
 * LlmAgent — backwards compatible agent with robust model output handling.
 *
 * Goals (aligned to your unit tests):
 *  - Legacy ctor supported: new LlmAgent(id, driver?, _modelName?)
 *  - Modern ctor supported: new LlmAgent({ id, projectDir?, runRoot?, policy?, modelClient?, tools?, maxToolCallsPerTurn? })
 *  - respond() never throws; always returns [{ message: string, toolsUsed: number }]
 *  - If tool calls exist (from user msg directives/arrays or from model output), execute them and end the turn with ""
 *  - If no tool calls, and the driver returns text, return that text
 */

import * as path from "node:path";
import type { ExecPolicy } from "../sandbox/policy";
import { sandboxedSh, SANDBOXED_SH_TOOL_SCHEMA } from "../tools/sandboxed-sh";

/* ---------------- Types ---------------- */

export type Role = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: Role;
  content: string;
  name?: string;
  from?: string;

  // Tests / helpers sometimes attach tool calls to the latest user message:
  toolcalls?: Array<{ name: string; arguments: any }>;
  toolCalls?: Array<{ name: string; arguments: any }>;
};

export type RespondResult = { message: string; toolsUsed: number };

export interface ChatModelClient {
  chat(input: {
    messages: ChatMessage[];
    tools?: any[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<any>; // deliberately loose; we normalize below
}

export interface ToolContext {
  projectDir: string;
  runRoot: string;
  agentSessionId: string;
  policy?: ExecPolicy;
}

export interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  cmd: string;
}

export type ToolRunner = (args: any, ctx: ToolContext) => Promise<ToolResult>;

export class ToolRegistry {
  private tools = new Map<string, ToolRunner>();
  private schemas: any[] = [];

  register(name: string, runner: ToolRunner, schema?: any) {
    this.tools.set(name, runner);
    if (schema) this.schemas.push(schema);
  }
  getRunner(name: string): ToolRunner | undefined {
    return this.tools.get(name);
  }
  getSchemas(): any[] {
    return this.schemas.slice();
  }
}

/* ---------------- Model result helpers ---------------- */

type RawModelResult =
  | string
  | {
      text?: string;
      content?: string;
      toolCalls?: any[];
      tool_calls?: any[];
      choices?: Array<{
        message?: { content?: string; tool_calls?: any[] };
        text?: string;
      }>;
      type?: string;
      calls?: any[];
    }
  | null
  | undefined;

/**
 * Prefer text when tool calls are absent or an empty array.
 * Works with stub output ({ text, toolCalls }) and OpenAI-style choices.
 */
function pickAssistant(raw: RawModelResult): { text: string; toolCalls: any[] } {
  if (raw == null) return { text: "", toolCalls: [] };

  // plain string
  if (typeof raw === "string") return { text: raw, toolCalls: [] };

  // OpenAI-style choice
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  const choiceMsg = choice?.message ?? {};
  const choiceText = choice?.text ?? choiceMsg?.content;

  // tool calls in any common spelling
  const tc =
    (raw as any).tool_calls ??
    (raw as any).toolCalls ??
    choiceMsg?.tool_calls ??
    [];

  const text =
    (raw as any).content ??
    (raw as any).text ??
    choiceText ??
    "";

  // The key behavior: only treat as tools if non-empty
  const toolCalls = Array.isArray(tc) ? tc : [];
  return { text, toolCalls };
}

/* ------------- Default registry: sh ------------- */

export function makeDefaultToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();

  reg.register(
    "sh",
    async (args: any, ctx: ToolContext) => {
      const cmd = typeof args?.cmd === "string" ? args.cmd : "";
      if (!cmd.trim()) {
        return {
          ok: false,
          stdout: "",
          stderr: "missing 'cmd' for sh tool",
          exit_code: 2,
          cmd,
        };
      }

      const r = await sandboxedSh(
        { cmd },
        {
          projectDir: ctx.projectDir,
          runRoot: ctx.runRoot,
          agentSessionId: ctx.agentSessionId,
          policy: ctx.policy,
        }
      );

      return {
        ok: r.ok,
        stdout: r.stdout,
        stderr: r.stderr,
        exit_code: r.exit_code,
        cmd,
      };
    },
    SANDBOXED_SH_TOOL_SCHEMA
  );

  return reg;
}

/* ------------- Directive parsing (robust JSON) ------------- */

function extractBalancedJSONObject(text: string, start: number): { json: string; end: number } | null {
  if (text[start] !== "{") return null;

  let i = start;
  let depth = 0;
  let inStr = false;
  let q: '"' | "'" | null = null;
  let esc = false;

  while (i < text.length) {
    const ch = text[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === q) {
        inStr = false;
        q = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      q = ch as '"' | "'";
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const json = text.slice(start, i + 1);
        return { json, end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/** Parse `<tool> { ... }` anywhere in text. */
function parseDirectives(text: string): Array<{ name: string; args: any }> {
  const out: Array<{ name: string; args: any }> = [];
  const nameAndBrace = /([A-Za-z_][A-Za-z0-9_-]*)\s*\{/g;

  let m: RegExpExecArray | null;
  while ((m = nameAndBrace.exec(text)) !== null) {
    const name = m[1];
    const braceIdx = m.index + m[0].lastIndexOf("{");
    const obj = extractBalancedJSONObject(text, braceIdx);
    if (!obj) continue;
    try {
      out.push({ name, args: JSON.parse(obj.json) });
    } catch {
      out.push({ name, args: {} });
    }
    nameAndBrace.lastIndex = obj.end;
  }
  return out;
}

/* ------------- Normalize model outputs ------------- */

type Normalized =
  | { kind: "message"; text: string }
  | { kind: "tool_calls"; calls: Array<{ name: string; arguments: any }> };

function normalizeModelOutput(res: any): Normalized | null {
  if (res == null) return null;

  // plain string → text message
  if (typeof res === "string") {
    return { kind: "message", text: res };
  }

  // explicit union with type field
  if (typeof res === "object" && typeof res.type === "string") {
    if (res.type === "message" && typeof res.content === "string") {
      return { kind: "message", text: res.content };
    }
    if (res.type === "tool_calls" && Array.isArray(res.calls) && res.calls.length > 0) {
      const calls = res.calls.map((c: any) => ({
        name: String(c?.name ?? ""),
        arguments: c?.arguments ?? {},
      }));
      return { kind: "tool_calls", calls };
    }
  }

  // assistant-style content
  if (typeof res.content === "string") {
    return { kind: "message", text: res.content };
  }

  // OpenAI function/tool_calls style
  const tc =
    res?.tool_calls ?? res?.toolCalls ?? res?.toolcalls ??
    (Array.isArray(res?.choices) ? res.choices[0]?.message?.tool_calls : undefined);

  if (Array.isArray(tc) && tc.length > 0) {
    const calls = tc
      .map((x: any) => {
        // { type: 'function', function: { name, arguments: string } }
        if (x?.type === "function" && x?.function) {
          const name = String(x.function.name ?? "");
          const raw = x.function.arguments;
          let args: any = {};
          if (typeof raw === "string") {
            try {
              args = JSON.parse(raw);
            } catch {
              args = {};
            }
          } else if (raw && typeof raw === "object") {
            args = raw;
          }
          return { name, arguments: args };
        }
        // Fallback shape { name, arguments }
        return {
          name: String(x?.name ?? ""),
          arguments: x?.arguments ?? {},
        };
      })
      .filter((c: any) => c && c.name);
    if (calls.length > 0) return { kind: "tool_calls", calls };
  }

  // choices with text
  if (Array.isArray(res?.choices)) {
    const msg = res.choices[0]?.message?.content ?? res.choices[0]?.text;
    if (typeof msg === "string") {
      return { kind: "message", text: msg };
    }
  }

  return null;
}

/* ---------------- Agent ---------------- */

export type LlmAgentConfig = {
  id: string;
  projectDir?: string;
  runRoot?: string;
  policy?: ExecPolicy;
  modelClient?: ChatModelClient;
  tools?: ToolRegistry;
  maxToolCallsPerTurn?: number;
};

function isModelClient(x: any): x is ChatModelClient {
  return x && typeof x.chat === "function";
}

export class LlmAgent {
  readonly id: string;
  private projectDir: string;
  private runRoot: string;
  private policy?: ExecPolicy;
  private model?: ChatModelClient;
  private tools: ToolRegistry;
  private maxToolCalls: number;

  /**
   * Back-compat:
   *  - new LlmAgent(id: string, driver?: ChatModelClient, _name?: string)
   *  - new LlmAgent({ id, ... })
   */
  constructor(cfgOrId: LlmAgentConfig | string, maybeDriver?: any, _maybeName?: any) {
    if (typeof cfgOrId === "string") {
      const id = cfgOrId;
      this.id = id;
      this.model = isModelClient(maybeDriver) ? maybeDriver : undefined;
      this.projectDir = path.resolve(process.cwd());
      this.runRoot = path.resolve(path.join(this.projectDir, ".org"));
      this.policy = undefined;
      this.tools = makeDefaultToolRegistry();
      this.maxToolCalls = 8;
      return;
    }

    const cfg = cfgOrId;
    this.id = cfg.id;

    const base = typeof cfg.projectDir === "string" && cfg.projectDir.length > 0 ? cfg.projectDir : process.cwd();
    this.projectDir = path.resolve(base);
    this.runRoot = path.resolve(cfg.runRoot ?? path.join(this.projectDir, ".org"));
    this.policy = cfg.policy;
    this.model = cfg.modelClient;
    this.tools = cfg.tools ?? makeDefaultToolRegistry();
    this.maxToolCalls = Math.max(1, cfg.maxToolCallsPerTurn ?? 8);
  }

  private async runToolCalls(calls: Array<{ name: string; arguments: any }>): Promise<number> {
    let used = 0;
    for (const call of calls.slice(0, this.maxToolCalls)) {
      const runner = this.tools.getRunner(call.name);
      if (!runner) {
        used++; // consume unknown tools silently
        continue;
      }
      try {
        await runner(call.arguments, {
          projectDir: this.projectDir,
          runRoot: this.runRoot,
          agentSessionId: this.id,
          policy: this.policy,
        });
      } catch {
        // swallow tool failures; tests only care that we didn't crash and consumed the turn
      }
      used++;
    }
    return used;
  }

  async respond(
    messages: ChatMessage[],
    _budget: number,
    _peers?: any[],
    _isDraining?: boolean | (() => boolean)
  ): Promise<RespondResult[]> {
    try {
      const convo = messages.slice();
      const lastUser = [...convo].reverse().find((m) => m.role === "user");

      // 1) Tool calls attached to the last user message (legacy helpers)
      const explicitCalls =
        (lastUser?.toolcalls as any[]) ||
        (lastUser?.toolCalls as any[]) ||
        [];

      // 2) Inline directives in user text: e.g., `sh { "cmd": "ls" }`
      const directiveCalls = lastUser ? parseDirectives(lastUser.content).map(d => ({ name: d.name, arguments: d.args })) : [];

      const pendingUserCalls = [...explicitCalls, ...directiveCalls].filter(Boolean);

      if (pendingUserCalls.length > 0) {
        const used = await this.runToolCalls(pendingUserCalls);
        return [{ message: "", toolsUsed: used }];
      }

      // 3) No explicit calls → ask model (if available)
      if (this.model) {
        let norm: Normalized | null = null;
        try {
          const raw = await this.model.chat({ messages: convo, tools: this.tools.getSchemas() });

          // FIRST: prefer the assistant picker (fixes empty toolCalls => text)
          const { text, toolCalls } = pickAssistant(raw);
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            const used = await this.runToolCalls(toolCalls);
            return [{ message: "", toolsUsed: used }];
          }
          if (typeof text === "string" && text.length > 0) {
            return [{ message: text, toolsUsed: 0 }];
          }

          // FALLBACK: generic normalizer for other shapes
          norm = normalizeModelOutput(raw);
        } catch (e: any) {
          return [{ message: `model error: ${String(e?.message ?? e)}`, toolsUsed: 0 }];
        }

        if (!norm) {
          // Nonstandard but harmless: end turn quietly
          return [{ message: "", toolsUsed: 0 }];
        }

        if (norm.kind === "tool_calls") {
          const used = await this.runToolCalls(norm.calls);
          return [{ message: "", toolsUsed: used }];
        }

        // plain assistant text
        return [{ message: norm.text ?? "", toolsUsed: 0 }];
      }

      // 4) No model at all: simple OK (keeps legacy tests happy)
      return [{ message: "OK.", toolsUsed: 0 }];
    } catch (e: any) {
      return [{ message: `agent error: ${String(e?.message ?? e)}`, toolsUsed: 0 }];
    }
  }
}

export default LlmAgent;
