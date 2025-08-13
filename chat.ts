// Global interrupt for the current streaming chat; SIGINT handler calls this
let _currentStreamAC: AbortController | null = null;
export function interruptChat() {
  try { _currentStreamAC?.abort(); } catch {}
  _currentStreamAC = null;
}
// --- Preflight cache and helpers ---
let _preflightOkUntil = 0;
let _knownModels: Set<string> | null = null;
const now = () => Date.now();

// Tip: set FORCE_V1=1 (or LMSTUDIO=1 / OPENAI_COMPAT=1) to skip Ollama /api preflight calls entirely.
const FORCE_V1 =
  process.env.FORCE_V1 === "1" ||
  process.env.LMSTUDIO === "1" ||
  process.env.OPENAI_COMPAT === "1";

const isV1Server = (u: string) => {
  if (FORCE_V1) return true; // manual override
  try {
    const hasV1 = /\/v1(\/|$)/i.test(u);
    const isKnownV1Host = /lmstudio|openai/i.test(u);
    return hasV1 || isKnownV1Host;
  } catch {
    return false;
  }
};

async function preflight(baseUrl: string, model: string): Promise<string | null> {
  // Skip Ollama-specific checks for OpenAI/LM Studio style servers
  if (isV1Server(baseUrl)) return null;
  const ttl = 5 * 60 * 1000; // 5 minutes
  if (now() < _preflightOkUntil && _knownModels && _knownModels.size) {
    if (_knownModels.has(model)) return null;
  }
  try {
    const v = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!v.ok) throw new Error(`version ${v.status}`);
    const t = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const tags = await t.json();
    const models = Array.isArray(tags?.models) ? tags.models.map((m: any) => m.name) : [];
    _knownModels = new Set(models);
    _preflightOkUntil = now() + ttl;
    if (!_knownModels.has(model)) return `Model "${model}" not found on server.`;
    return null;
  } catch (e: any) {
    return `Preflight failed: ${e?.message || String(e)}`;
  }
}
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
// Enable raw stream debug with: DEBUG_STREAM=1 bun main.ts
const DEBUG_STREAM = process.env.DEBUG_STREAM === "1";
const SHOW_THINK = process.env.SHOW_THINK === "1"; // show chain-of-thought when set

// Allow overriding connection/first-chunk timeouts: "4000,8000,15000"
function getConnectTimeouts(): number[] {
  const raw = (process.env.CHAT_CONNECT_TIMEOUTS_MS || "4000,8000,15000").trim();
  const parts = raw.split(",").map(s => Math.max(500, Number(s.trim()) || 0)).filter(Boolean);
  return parts.length ? parts : [4000, 8000, 15000];
}
// Kill-switches to troubleshoot "no output" situations
const DISABLE_ABORT = process.env.DISABLE_ABORT === "1";             // disables all abort detectors & soft suppression
const DISABLE_GARBAGE_FILTER = process.env.DISABLE_GARBAGE_FILTER === "1"; // prints everything even if it looks like tool JSON, etc.
import type { ReadableStreamReadResult } from "stream/web";

const BASE_URL = "http://192.168.56.1:11434"; // host-only IP
// Default model can be overridden via env OLLAMA_MODEL
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "openai/gpt-oss-20b";

// Patterns to suppress from terminal output (still kept in buffers)
const GARBAGE_RES: RegExp[] = [
  /\b"tool_calls"\s*:\s*\[/i,                  // assistant echoing tool JSON
  /\b"ok"\s*:\s*(true|false)\s*,\s*"stdout"/i, // quoted tool result blobs
  /<\|start\|>/i,                                  // special markers some models leak
  /functions\.sh\s+to=assistant/i,                // tool routing artifacts
  /<\s*[a-z0-9_-]+\s*\|\s*commentary\b[^>]*>/i,   // channel|commentary artifacts
];
const isGarbage = (s: string): boolean => DISABLE_GARBAGE_FILTER ? false : GARBAGE_RES.some(re => re.test(s));

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
  const model = opts?.model ?? DEFAULT_MODEL;
  const timeout = Math.max(2000, Math.min(120_000, opts?.timeout_ms ?? 120_000));

  // Use preflight cache and checks
  const pf = await preflight(ollamaBaseUrl, model);
  if (pf) return "";

  const formatted = messages.map(formatMessage);

  // OpenAI-compatible /v1/chat/completions (non-streaming)
  const v1Body = {
    model,
    stream: false,            // non‑streaming summary
    messages: formatted,
    temperature: opts?.temperature ?? 0, // deterministic summaries
    keep_alive: "20m",
  } as any;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const resp = await fetch(ollamaBaseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v1Body),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return "";
    const json = await resp.json();
    const viaV1 = (json && json.choices && json.choices[0] && json.choices[0].message && typeof json.choices[0].message.content === "string")
      ? json.choices[0].message.content : null;
    return (viaV1 ?? "").trim();
  } catch {
    clearTimeout(t);
    return "";
  }
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
  const model = opts?.model ?? DEFAULT_MODEL;

  // Use preflight cache and checks
  const pf = await preflight(ollamaBaseUrl, model);
  if (pf) return { role: "assistant", content: pf };

  // Install model-provided abort detectors (if any), unless disabled
  if (DISABLE_ABORT) {
    abortRegistry.set([]);
  } else if (opts?.abortDetectors && Array.isArray(opts.abortDetectors)) {
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
    keep_alive: "30m",
    num_ctx: 128000
    // some Ollama builds also accept num_ctx here; include if needed via options
  } as any;

  // Single-endpoint strategy: OpenAI-compatible /v1/chat/completions (tool calling)
  let resp: Response | undefined;
  const timeouts = getConnectTimeouts();
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const connectAC = new AbortController();
    _currentStreamAC = connectAC; // expose for external interrupt
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

        console.log(txt);

        return { role: "assistant", content: `HTTP ${resp.status} – ${resp.statusText}\n${txt}` };
      }
      // Print header as soon as we have HTTP 200 to show liveness
      let namePrinted = false;
      {
        const ts = new Date().toLocaleTimeString();
        console.log(`\x1b[36m**** ${name} @ ${ts}\x1b[0m:`);
        namePrinted = true;
      }

      // Inspect content type once per request
      const ctype = String(resp.headers.get("content-type") || "");
      if (DEBUG_STREAM) console.error(`[chatOnce] content-type: ${ctype}`);

      // Fast path: some servers reply with a single JSON (no SSE)
      if (/application\/json/i.test(ctype) && !/text\/event-stream/i.test(ctype)) {
        const json = await resp.json().catch(() => null as any);
        if (json && json.choices && json.choices[0]) {
          const ch = json.choices[0];
          const msg = ch.message || ch.delta || {};
          const contentStr = typeof msg.content === "string" ? msg.content : "";
          const reasoningStr = typeof msg.reasoning === "string" ? msg.reasoning : "";
          // tool calls may be fully present on non-streaming responses
          const tc = Array.isArray(msg.tool_calls) ? msg.tool_calls : (Array.isArray(ch.tool_calls) ? ch.tool_calls : undefined);

          if (contentStr) Bun.stdout.write(contentStr + "\n");
          if (!contentStr && reasoningStr && SHOW_THINK) {
            Bun.stdout.write(`<think>${reasoningStr.trim()}</think>\n`);
          }
          _currentStreamAC = null;
          return { role: "assistant", content: contentStr.trim(), reasoning: reasoningStr, tool_calls: tc };
        }
        // If JSON but not in expected shape, fall through to stream reader (some servers still chunk JSON lines)
      }

      // Streaming/SSE path
      let reader = resp.body!.getReader();
      const decoder = new TextDecoder("utf-8");

      // Show a subtle spinner/dot while waiting for the first bytes
      let firstChunkArrived = false;
      const waitDots = setInterval(() => {
        if (!firstChunkArrived) { try { Bun.stdout.write("."); } catch {} }
      }, 250);

      let firstReadTimedOut = false;
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => { firstReadTimedOut = true; rej(new Error("first-chunk-timeout")); }, timeouts[attempt])),
      ] as any);
      firstChunkArrived = true;
      clearInterval(waitDots);

      (resp as any)._org_firstChunk = first;
      (resp as any)._org_reader = reader;
      (resp as any)._org_decoder = decoder;
      // keep namePrinted state for the outer loop
      (resp as any)._org_namePrinted = namePrinted;
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
    const abortP = _currentStreamAC?.signal ? new Promise<never>((_, rej) => {
      const onAbort = () => { _currentStreamAC?.signal.removeEventListener('abort', onAbort as any); rej(new Error('interrupted')); };
      _currentStreamAC!.signal.addEventListener('abort', onAbort, { once: true });
    }) : undefined;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('idle-timeout')), IDLE_MS)),
      ...(abortP ? [abortP] : []),
    ]) as any;
  }

  let contentBuf = "";
  let thinkingBuf = "";
  let toolCalls: ToolCall[] | undefined;
  let done = false;
  let namePrinted = Boolean((resp as any)._org_namePrinted);
  let firstThink = true;
  let firstNotThink = true;
  let tokenCount = 0; // counts emitted non-empty content/reasoning units
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
  // Detector performance guards
  const DET_CHECK_CHARS_THRESHOLD = 400; // run expensive detectors only after this many new chars
  const DET_TAIL_WINDOW = 8000;          // pass only the last N chars to detectors
  let detSinceChars = 0;                 // chars accumulated since last detector run
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
      const msg = (e as Error)?.message || '';
      if (msg === 'idle-timeout') {
        try { reader.cancel(); } catch {}
        console.error('[chatOnce] aborted stream: idle-timeout');
        break;
      }
      if (msg === 'interrupted') {
        try { reader.cancel(); } catch {}
        console.error('[chatOnce] aborted stream: interrupted');
        break;
      }
      throw e;
    }
    const { value, done: streamDone } = readResult;

    if (streamDone) break;
    const chunk = decoder.decode(value, { stream: true });
    if (DEBUG_STREAM) console.error("RAW:", chunk.replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
    lineBuffer += chunk;

    // Process only complete lines; keep remainder for next network chunk
    for (;;) {
      const nl = lineBuffer.indexOf('\n');
      if (nl === -1) break;
      let lineRaw = lineBuffer.slice(0, nl);
      lineBuffer = lineBuffer.slice(nl + 1);
      // Trim a single trailing CR but do not trim leading spaces (SSE spec)
      const line = lineRaw.endsWith('\r') ? lineRaw.slice(0, -1) : lineRaw;
      if (DEBUG_STREAM) console.error("LINE:", line);
      if (!line) continue;

      // Skip non-data SSE lines from OpenAI/LM Studio (e.g., event:, id:, retry:, or comment ":")
      if (!line.startsWith('data:')) {
        if (/^(event|id|retry):/i.test(line) || line.startsWith(':')) {
          if (DEBUG_STREAM) console.error("SKIP:", line);
          continue;
        }
      }

      // Ollama native streams JSON lines without the "data:" prefix; OpenAI-style uses "data: {json}"
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;


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
      if (finishReason === "stop") {
        done = true;
        // continue to process any residual delta fields below before breaking out at loop end
      }

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

      // Chain‑of‑thought handling: show if SHOW_THINK=1, else suppress with a dot
      if (reasonStr) {
        if (SHOW_THINK) {
          if (firstThink) { firstThink = false; Bun.stdout.write("<think>"); }
          Bun.stdout.write(reasonStr);
          tokenCount++;
        } else {
          if (firstThink) { firstThink = false; }
          if (DEBUG_STREAM) console.error("[COT suppressed]", reasonStr.slice(0, 40));
          emitDot();
          tokenCount++;
        }
      }
      if (contentStr) {
        tokenCount++;
        if (firstNotThink && !firstThink) { firstNotThink = false; }

        // When SHOW_THINK=1, bypass garbage/suppression filters to reveal raw CoT-like text.
        if (SHOW_THINK) {
          Bun.stdout.write(contentStr);
        } else {
          const looksGarbage =
            isGarbage(contentStr) || isGarbage(contentBuf.slice(-200) + contentStr);
          if (looksGarbage) {
            squelchedChars += contentStr.length;
            emitDot();
          } else {
            if (!suppressOutput) {
              Bun.stdout.write(contentStr);
            } else {
              // output suppressed by soft‑abort -> show progress dot
              emitDot();
            }
          }
        }
      } else if (!reasonStr && parsed && parsed.done === true) {
        done = true; 
        
        break;
      }

      // Print a dot immediately when output is suppressed by application logic
      if (suppressOutput && contentStr && !(isGarbage(contentStr) || isGarbage(contentBuf.slice(-200) + contentStr))) {
        // Only print a dot for suppressed normal output (not for garbage, which already emits a dot)
        Bun.stdout.write(".");
      }

      if (contentStr) {
        contentBuf += contentStr;
        detSinceChars += contentStr.length;
      }
      if (reasonStr) thinkingBuf += reasonStr;
      if (delta.tool_calls) toolCalls = delta.tool_calls as ToolCall[];

      // Generic, model-pluggable abort check (soft-abort: do not cancel the stream)
      const agents = Array.from(new Set((messages || []).map(m => (m?.from || '').toLowerCase()).filter(Boolean)));
      if (!DISABLE_ABORT && cutAt === null && detSinceChars >= DET_CHECK_CHARS_THRESHOLD) {
        detSinceChars = 0; // reset the counter now
        const textForDetectors = contentBuf.length > DET_TAIL_WINDOW
          ? contentBuf.slice(-DET_TAIL_WINDOW)
          : contentBuf;
        let cut: { index: number; reason: string } | null = null;
        for (const det of abortRegistry.detectors) {
          cut = det.check(textForDetectors, { messages, agents, soc: opts?.soc });
          if (cut) {
            // Adjust cut.index to absolute index relative to contentBuf
            const offset = contentBuf.length - textForDetectors.length;
            cutAt = Math.max(0, offset + cut.index);
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
      if (DEBUG_STREAM) console.error("FINAL_LINE:", payload);
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

  // If we printed any visible CoT, close the tag
  if (SHOW_THINK && !firstThink) {
    Bun.stdout.write("\n</think>\n");
  }
  // Ensure a newline after the streamed content for tidy terminal rendering
  if (namePrinted) {
    Bun.stdout.write("\n");
  }

  if (cutAt !== null) {
    contentBuf = contentBuf.slice(0, cutAt).trimEnd();
  }
  if (!namePrinted) {
    console.log(`**** ${name}:`);
  }
  if (!contentBuf && SHOW_THINK && thinkingBuf) {
    Bun.stdout.write("\n");
  }
  // Surface a heartbeat so the user knows we reached end-of-stream without tokens
  if (tokenCount === 0) {
    try { Bun.stdout.write("."); } catch {}
  }
  _currentStreamAC = null;
  return {
    role: "assistant",
    content: contentBuf.trim(),
    reasoning: thinkingBuf,
    tool_calls: toolCalls,
  };
}
