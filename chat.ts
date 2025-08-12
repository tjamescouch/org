/** Pluggable abort detector API */
export interface AbortDetector {
  /** Human-friendly name */
  name: string;
  /**
   * Inspect the accumulated assistant text and optionally request an abort.
   * Return { index, reason } to cut the stream at `index`, or null to continue.
   */
  check(
    text: string,
    ctx: { messages: ChatMessage[]; agents: string[] }
  ): { index: number; reason: string } | null;
}

/** Simple registry; models provide detectors at runtime via chatOnce opts */
export const abortRegistry = {
  detectors: [] as AbortDetector[],
  set(list: AbortDetector[]) { this.detectors = list.slice(); },
  add(detector: AbortDetector) { this.detectors.push(detector); },
};
import { TextDecoder } from "util";
import { VERBOSE } from './constants';

const BASE_URL = "http://192.168.56.1:11434"; // host-only IP
const MODEL = "gpt-oss:20b";

// ---- Types (OpenAI-style) ----
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  from: string;
  role: ChatRole;
  content: string;
  read: boolean;
  name?: string;           // for tool messages
  tool_call_id?: string;   // for tool messages
  reasoning?: string;
  recipient?: string;
  ts?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
  index?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

const formatMessage = (m: ChatMessage): any => {
  // Only send fields the API understands, and never prefix tool/system content
  if (m.role === "tool") {
    return { role: "tool", content: String(m.content ?? ""), name: m.name, tool_call_id: m.tool_call_id };
  }
  if (m.role === "system" || m.role === "assistant") {
    return { role: m.role, content: String(m.content ?? "") };
  }
  // user: optionally include speaker label inside content for multi-agent context
  return { role: "user", content: `${m.from}: ${String(m.content ?? "")}` };
};



// Non-streaming summarizer: returns a single message string
export async function summarizeOnce(
  messages: ChatMessage[],
  opts?: {
    model?: string;
    baseUrl?: string;
    temperature?: number;
    num_ctx?: number;
    timeout_ms?: number;
  }
): Promise<string> {
  const ollamaBaseUrl = opts?.baseUrl ?? BASE_URL;
  const model = opts?.model ?? MODEL;
  const timeout = Math.max(2000, Math.min(60_000, opts?.timeout_ms ?? 12_000));

  // quick preflight
  try {
    const r1 = await fetch(`${ollamaBaseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!r1.ok) throw new Error(`server responded ${r1.status}`);
  } catch (e) {
    return "";
  }

  const formatted = messages.map(formatMessage);
  // Prefer native /api/chat for non-streaming; fall back to /v1 if needed
  const bodies = [
    {
      path: "/api/chat",
      body: {
        model,
        stream: false,
        messages: formatted,
        keep_alive: "20m",
        options: { num_ctx: opts?.num_ctx ?? 4096, temperature: opts?.temperature ?? 0 },
      }
    },
    {
      path: "/v1/chat/completions",
      body: {
        model,
        stream: false,
        messages: formatted,
        temperature: opts?.temperature ?? 0,
      }
    }
  ];

  for (const { path, body } of bodies) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const resp = await fetch(ollamaBaseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const json = await resp.json();
      // /api/chat -> { message: { content } }, /v1 -> { choices: [{ message: { content } }]}
      const viaApi = (json && json.message && typeof json.message.content === "string") ? json.message.content : null;
      const viaV1  = (json && json.choices && json.choices[0] && json.choices[0].message && typeof json.choices[0].message.content === "string")
        ? json.choices[0].message.content : null;
      return (viaApi ?? viaV1 ?? "").trim();
    } catch {
      clearTimeout(t);
      continue;
    }
  }
  return "";
}

export async function chatOnce(
  name: string,
  messages: ChatMessage[],
  opts?: {
    tools?: ToolDef[];
    tool_choice?: "auto" | { type: "function"; function: { name: string } };
    num_ctx?: number;
    temperature?: number;
    model?: string;
    baseUrl?: string;
    abortDetectors?: AbortDetector[];
  }
): Promise<AssistantMessage> {
  const ollamaBaseUrl = opts?.baseUrl ?? BASE_URL;
  const model = opts?.model ?? MODEL;
  const url = `${ollamaBaseUrl}/api/chat`;

  // Preflight Ollama and model list (fast)
  try {
    const r1 = await fetch(`${ollamaBaseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!r1.ok) throw new Error(`server responded ${r1.status}`);
    const r2 = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const tags = await r2.json();
    const haveModel = Array.isArray((tags as any)?.models) && (tags as any).models.some((m: any) => m.name === model);
    if (!haveModel) return { role: "assistant", content: `Model "${model}" not found on server.` };
  } catch (e) {
    return { role: "assistant", content: `Preflight failed: ${(e as Error).message}` };
  }

  // Install model-provided abort detectors (if any)
  if (opts?.abortDetectors && Array.isArray(opts.abortDetectors)) {
    abortRegistry.set(opts.abortDetectors);
  } else {
    abortRegistry.set([]); // default: no detectors
  }

  if (VERBOSE) console.error(messages.map(formatMessage));

  // Shared body pieces
  const formatted = messages.map(formatMessage);
  const v1Body = {
    model,
    stream: true,
    messages: formatted,
    temperature: opts?.temperature ?? 0,
    tools: opts?.tools ?? [],
    tool_choice: opts?.tool_choice ?? (opts?.tools ? "auto" : undefined),
  } as any;
  const apiBody = {
    model,
    stream: true,
    messages: formatted,
    keep_alive: "30m",
    options: { num_ctx: 8192 },
  } as any;

  // We'll try /v1/chat/completions first (tools supported), then fall back to /api/chat
  type Prim = "v1" | "api";
  let primary: Prim = "v1";
  let resp: Response | undefined;
  const timeouts = [5000, 10000, 20000];
  let attempt = 0;
  for (; attempt < timeouts.length; ++attempt) {
    const connectAC = new AbortController();
    const t = setTimeout(() => connectAC.abort(), timeouts[attempt]);
    try {
      const path = primary === "v1" ? "/v1/chat/completions" : "/api/chat";
      const body = primary === "v1" ? v1Body : apiBody;
      resp = await fetch(ollamaBaseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: connectAC.signal,
      });
      clearTimeout(t);
      if (!resp.ok) {
        const txt = await resp.text();
        // If /v1 failed, try /api next
        if (primary === "v1") { primary = "api"; attempt = -1; continue; }
        return { role: "assistant", content: `HTTP ${resp.status} – ${resp.statusText}\n${txt}` };
      }
      // Wait for first chunk with timeout; if it times out on v1, switch to api and retry
      let reader = resp.body!.getReader();
      const decoder = new TextDecoder("utf-8");
      let firstReadTimedOut = false;
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => { firstReadTimedOut = true; rej(new Error("first-chunk-timeout")); }, timeouts[attempt])),
      ] as any);
      if (firstReadTimedOut) throw new Error("first-chunk-timeout");
      // success: stash reader/decoder/first
      (resp as any)._org_firstChunk = first;
      (resp as any)._org_reader = reader;
      (resp as any)._org_decoder = decoder;
      break;
    } catch (e) {
      clearTimeout(t);
      // If v1 is flaky, drop to api once; otherwise backoff
      if (primary === "v1") {
        primary = "api"; attempt = -1; continue;
      }
      if (attempt < timeouts.length - 1) await new Promise(r => setTimeout(r, timeouts[attempt]));
    }
  }

  if (!resp || (resp as any)._org_firstChunk === undefined) {
    return { role: "assistant", content: "Model is warming or unavailable, please retry later" };
  }

  /* -----------------------------------------------------------
     Parse the SSE / chunked response:
     Each chunk is a line:  data: { ...delta... }\n
     Last line:            data: [DONE]
  ------------------------------------------------------------ */
  let reader = (resp as any)._org_reader;
  const decoder = (resp as any)._org_decoder;
  let firstRead = true;
  let firstReadResult: ReadableStreamReadResult<Uint8Array> = (resp as any)._org_firstChunk;

  // Idle+hard-stop watchdogs to prevent hangs
  const IDLE_MS = 150_000;     // abort if no chunks for 150s
  const HARD_STOP_MS = 120_000; // absolute cap on streaming
  const startedAt = Date.now();

  async function readWithIdleTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (firstRead) {
      firstRead = false;
      return firstReadResult;
    }
    return Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("idle-timeout")), IDLE_MS))
    ]) as any;
  }

  let contentBuf = "";
  let thinkingBuf = "";
  let toolCalls: ToolCall[] | undefined;
  let done = false;
  let namePrinted = false;
  let firstThink = true;
  let firstNotThink = true;

  while (!done) {
    if (Date.now() - startedAt > HARD_STOP_MS) {
      try { reader.cancel(); } catch {}
      console.error("[chatOnce] aborted stream: hard-stop");
      break;
    }
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await readWithIdleTimeout();
    } catch (e) {
      if ((e as Error)?.message === "idle-timeout") {
        try { reader.cancel(); } catch {}
        console.error("[chatOnce] aborted stream: idle-timeout");
        break;
      }
      throw e;
    }
    const { value, done: streamDone } = readResult;

    if (streamDone) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const lineRaw of chunk.split("\n")) {
      const line = lineRaw.trim();
      if (!line) continue;

      // Ollama native streams JSON lines without the "data:" prefix; OpenAI-style uses "data: {json}"
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line;

      if(!namePrinted) {
        console.log(`\n\n**** ${name}:`);
        namePrinted = true;
      }

      if (payload === "[DONE]") {
        done = true;
        break;
      }

      try {
        // Native Ollama /api/chat: emits objects with { message: { content, role, ... }, done, ... }
        // Try to parse as either OpenAI or Ollama native
        let parsed: any = {};
        try {
          parsed = JSON.parse(payload);
        } catch {}
        let delta: any = {};
        // OpenAI format: { choices: [{ delta: { content, ... } }] }
        if (parsed.choices && Array.isArray(parsed.choices)) {
          delta = parsed.choices?.[0]?.delta ?? {};
        } else if (parsed.message) {
          // Ollama native: { message: { content, role, ... }, ... }
          delta = parsed.message;
        }

        // Some Ollama builds emit { done: true } without a message
        if (!parsed.message && parsed.done === true) {
          done = true;
          break;
        }

        // Coerce and guard writes; Ollama may emit non-string/empty fields on keepalive chunks
        const reasonStr = typeof delta.reasoning === "string" ? delta.reasoning : "";
        const contentStr = typeof delta.content === "string" ? delta.content : "";

        if (reasonStr) {
          if (firstThink) {
            firstThink = false;
            console.log("<think>");
          }
          Bun.stdout.write(reasonStr);
        }

        if (contentStr) {
          if (firstNotThink && !firstThink) {
            firstNotThink = false;
            console.log("\n</think>\n");
          }
          Bun.stdout.write(contentStr);
        } else if (!reasonStr) {
          // Neither content nor reasoning: if this is an Ollama heartbeat/done chunk, handle gracefully
          if (parsed && parsed.done === true) {
            done = true;
            break;
          }
        }

        if (contentStr) contentBuf += contentStr;
        if (reasonStr) thinkingBuf += reasonStr;
        if (delta.tool_calls) toolCalls = delta.tool_calls as ToolCall[];

        // Generic, model-pluggable abort check
        const agents = Array.from(new Set((messages || []).map(m => (m?.from || "").toLowerCase()).filter(Boolean)));
        let cut: { index: number; reason: string } | null = null;
        for (const det of abortRegistry.detectors) {
          cut = det.check(contentBuf, { messages, agents });
          if (cut) {
            // Trim content to before the offending pattern and stop streaming
            contentBuf = contentBuf.slice(0, Math.max(0, cut.index)).trimEnd();
            try { reader.cancel(); } catch {}
            done = true;
            if(firstNotThink && !firstThink) {
              firstNotThink = false;
              console.log("\n</think>\n");
            }
            console.error(`[chatOnce] aborted stream by ${det.name}: ${cut.reason}`);
            break;
          }
        }
        if (done) break;
      } catch (e) {
        console.warn("⚠️  Bad chunk:", e);
      }
    }

  }

  return {
    role: "assistant",
    content: contentBuf.trim(),
    reasoning: thinkingBuf,
    tool_calls: toolCalls,
  };
}
