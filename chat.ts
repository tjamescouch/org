/** Pluggable abort detector API */
export type AbortDetector = {
  name: string;
  check(
    text: string,
    ctx: { messages: ChatMessage[]; agents: string[]; soc?: string }
  ): { index: number; reason: string } | null;
};

/** Simple registry; models provide detectors at runtime via chatOnce opts */
export const abortRegistry = {
  detectors: [] as AbortDetector[],
  set(list: AbortDetector[]) { this.detectors = list.slice(); },
  add(detector: AbortDetector) { this.detectors.push(detector); },
};
import { TextDecoder } from "util";
import { VERBOSE } from './constants';
import type { ReadableStreamReadResult } from "stream/web";

const BASE_URL = "http://192.168.56.1:11434"; // host-only IP
const MODEL = "gpt-oss:20b";

// Patterns to suppress from terminal output (still kept in buffers)
const GARBAGE_RES: RegExp[] = [
  /\b"tool_calls"\s*:\s*\[/i,                  // assistant echoing tool JSON
  /\b"ok"\s*:\s*(true|false)\s*,\s*"stdout"/i, // quoted tool result blobs
  /<\|start\|>/i,                                  // special markers some models leak
  /functions\.sh\s+to=assistant/i,                // tool routing artifacts
];
const isGarbage = (s: string): boolean => GARBAGE_RES.some(re => re.test(s));

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
        options: { num_ctx: opts?.num_ctx ?? 128000, temperature: opts?.temperature ?? 0 },
      }
    },
    {
      path: "/v1/chat/completions",
      body: {
        model,
        stream: false,
        messages: formatted,
        temperature: opts?.temperature ?? 0,
	max_output_tokens: 100000
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
    tool_choice?: "auto" | { type: "function"; function: { name: string } } | "none";
    num_ctx?: number;
    temperature?: number;
    model?: string;
    baseUrl?: string;
    abortDetectors?: AbortDetector[];
    soc?: string; // rolling stream-of-consciousness used for cross-turn repetition detection
  }
): Promise<AssistantMessage> {
  const ollamaBaseUrl = opts?.baseUrl ?? BASE_URL;
  const model = opts?.model ?? MODEL;

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
    temperature: opts?.temperature ?? 1,
    tools: opts?.tools ?? [],
    tool_choice: opts?.tool_choice ?? (opts?.tools ? "auto" : undefined),
    keep_alive: "30m", // keep model warm between hops (Ollama extension)
  } as any;

  // Single-endpoint strategy: OpenAI-compatible /v1/chat/completions (tool calling)
  let resp: Response | undefined;
  const timeouts = [10000, 20000, 40000];
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const connectAC = new AbortController();
    const t = setTimeout(() => connectAC.abort(), timeouts[attempt]);
    try {
      resp = await fetch(ollamaBaseUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v1Body),
        signal: connectAC.signal,
      });
      clearTimeout(t);
      if (!resp.ok) {
        const txt = await resp.text();
        return { role: "assistant", content: `HTTP ${resp.status} – ${resp.statusText}\n${txt}` };
      }
      // Wait for first chunk with timeout
      let reader = resp.body!.getReader();
      const decoder = new TextDecoder("utf-8");
      let firstReadTimedOut = false;
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => { firstReadTimedOut = true; rej(new Error("first-chunk-timeout")); }, timeouts[attempt])),
      ] as any);
      if (firstReadTimedOut) throw new Error("first-chunk-timeout");
      (resp as any)._org_firstChunk = first;
      (resp as any)._org_reader = reader;
      (resp as any)._org_decoder = decoder;
      break;
    } catch (e) {
      clearTimeout(t);
      if (attempt < timeouts.length - 1) {
        await new Promise(r => setTimeout(r, timeouts[attempt]));
        continue;
      }
      return { role: "assistant", content: `Connect/first-chunk failed: ${(e as Error).message}` };
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
  const IDLE_MS = 240_000;     // abort if no chunks for 240s
  const HARD_STOP_MS = 300_000; // absolute cap on streaming (must exceed IDLE_MS)
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
  // Accumulate partial lines across chunks (SSE / JSONL)
  let lineBuffer = "";
  // Soft-abort state: keep reading to the end but suppress further terminal output
  let cutAt: number | null = null;
  let suppressOutput = false;
  // Accumulate tool call pieces across deltas (OpenAI streams name/arguments incrementally)
  const toolCallsAgg: { [k: number]: ToolCall } = {};
  // Squelch noisy/garbage fragments and show progress dots instead
  let squelchedChars = 0;
  let lastDotAt = 0;
  const emitDot = () => {
    const now = Date.now();
    if (now - lastDotAt > 200) { // at most ~5 dots/sec
      Bun.stdout.write(".");
      lastDotAt = now;
    }
  };
  const ensureTool = (idx: number): ToolCall => {
    if (!toolCallsAgg[idx]) toolCallsAgg[idx] = { id: `call_${idx}`, type: "function", function: { name: "", arguments: "" }, index: idx };
    return toolCallsAgg[idx];
  };

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
    lineBuffer += chunk;

    // Process only complete lines; keep remainder for next network chunk
    for (;;) {
      const nl = lineBuffer.indexOf('\n');
      if (nl === -1) break;
      let lineRaw = lineBuffer.slice(0, nl);
      lineBuffer = lineBuffer.slice(nl + 1);
      // Trim a single trailing CR but do not trim leading spaces (SSE spec)
      const line = lineRaw.endsWith('\r') ? lineRaw.slice(0, -1) : lineRaw;
      if (!line) continue;

      // Ollama native streams JSON lines without the "data:" prefix; OpenAI-style uses "data: {json}"
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;

      if (!namePrinted) {
        console.log(`\n\n**** ${name}:`);
        namePrinted = true;
      }

      if (payload === '[DONE]') { done = true; break; }

      // Parse JSON payload; if it fails, prepend it back into the buffer and wait for more bytes
      let parsed: any = undefined;
      try { parsed = JSON.parse(payload); } catch {
        // likely a partial JSON frame split across network chunks
        lineBuffer = line + '\n' + lineBuffer; // restore and wait for the remainder
        break;
      }

      let delta: any = {};
      if (parsed && parsed.choices && Array.isArray(parsed.choices)) {
        const ch = parsed.choices?.[0] ?? {};
        delta = (ch.delta ?? ch.message ?? {});
      } else if (parsed && parsed.message) {
        delta = parsed.message;
      }

      // OpenAI finish reason appears on the choice, even when delta is empty
      const choice = parsed?.choices?.[0] ?? {};
      const finishReason = choice?.finish_reason as (string | null | undefined);

      // Some Ollama builds emit { done: true } without a message
      if (!parsed?.message && parsed?.done === true) { 
        // finalize any aggregated tool calls
        const agg = Object.values(toolCallsAgg);
        if (agg.length) toolCalls = agg;
        done = true; 
        break; 
      }

      // Merge tool call deltas (name/arguments may arrive piecewise)
      if (delta && Array.isArray(delta.tool_calls)) {
        for (const d of delta.tool_calls as any[]) {
          const idx = typeof d.index === "number" ? d.index : 0;
          const t = ensureTool(idx);
          if (d.id && !t.id) t.id = d.id;
          if (d.function?.name) t.function.name = d.function.name;
          if (typeof d.function?.arguments === "string") {
            t.function.arguments = (t.function.arguments || "") + d.function.arguments;
          }
        }
      }
      if (finishReason === "tool_calls") {
        const agg = Object.values(toolCallsAgg);
        if (agg.length) toolCalls = agg;
        done = true;
        // don't break before we print any last textual content below
      }

      // Coerce and guard writes; Ollama may emit non-string/empty fields on keepalive chunks
      const reasonStr = typeof delta.reasoning === 'string' ? delta.reasoning : '';
      const contentStr = typeof delta.content === 'string' ? delta.content : '';

      // Suppress visible chain-of-thought; keep for detectors only
      if (reasonStr) {
         if (firstThink) { firstThink = false; console.log('<think>'); }
         Bun.stdout.write(reasonStr);
      }
      if (contentStr) {
        if (firstNotThink && !firstThink) { firstNotThink = false; }
        if (isGarbage(contentStr) || isGarbage(contentBuf.slice(-200) + contentStr)) {
          squelchedChars += contentStr.length;
          emitDot();
        } else {
          if (!suppressOutput) Bun.stdout.write(contentStr);
        }
      } else if (!reasonStr && parsed && parsed.done === true) {
        done = true; 
        
        break;
      }

      if (contentStr) contentBuf += contentStr;
      if (reasonStr) thinkingBuf += reasonStr;
      if (delta.tool_calls) toolCalls = delta.tool_calls as ToolCall[];

      // Generic, model-pluggable abort check (soft-abort: do not cancel the stream)
      const agents = Array.from(new Set((messages || []).map(m => (m?.from || '').toLowerCase()).filter(Boolean)));
      if (cutAt === null) {
        let cut: { index: number; reason: string } | null = null;
        for (const det of abortRegistry.detectors) {
          cut = det.check(contentBuf, { messages, agents, soc: opts?.soc });
          if (cut) {
            cutAt = Math.max(0, cut.index);
            suppressOutput = true; // continue reading but do not print further tokens
            if (firstNotThink && !firstThink) { firstNotThink = false; console.log('\n</think>\n'); }
            console.error(`[chatOnce] soft-abort by ${det.name}: ${cut.reason} cutAt=${cutAt}`);
            break;
          }
        }
      }
    }
  }

  // Best-effort: process a final line if the server ended without a trailing newline
  if (!done && lineBuffer.trim().length > 0) {
    try {
      const payload = lineBuffer.startsWith('data:') ? lineBuffer.slice(5).trim() : lineBuffer;
      const parsed: any = JSON.parse(payload);
      const ch = parsed?.choices?.[0] ?? {};
      const delta = (ch.delta ?? ch.message ?? parsed?.message ?? {});
      const reasonStr = typeof delta.reasoning === 'string' ? delta.reasoning : '';
      const contentStr = typeof delta.content === 'string' ? delta.content : '';
      if (reasonStr) thinkingBuf += reasonStr;
      if (contentStr) contentBuf += contentStr;
      if (Array.isArray(delta.tool_calls)) {
        for (const d of delta.tool_calls as any[]) {
          const idx = typeof d.index === "number" ? d.index : 0;
          const t = ensureTool(idx);
          if (d.id && !t.id) t.id = d.id;
          if (d.function?.name) t.function.name = d.function.name;
          if (typeof d.function?.arguments === "string") {
            t.function.arguments = (t.function.arguments || "") + d.function.arguments;
          }
        }
      }
      const agg = Object.values(toolCallsAgg);
      if (agg.length) toolCalls = agg;
    } catch {}
  }

  if (squelchedChars > 0) {
    Bun.stdout.write("\n");
  }

  if (cutAt !== null) {
    contentBuf = contentBuf.slice(0, cutAt).trimEnd();
  }
  return {
    role: "assistant",
    content: contentBuf.trim(),
    reasoning: thinkingBuf,
    tool_calls: toolCalls,
  };
}
