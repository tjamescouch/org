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


let ollamaWarmedUp = false;

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

  // Install model-provided abort detectors (if any)
  if (opts?.abortDetectors && Array.isArray(opts.abortDetectors)) {
    abortRegistry.set(opts.abortDetectors);
  } else {
    abortRegistry.set([]); // default: no detectors
  }

  if (VERBOSE) console.error(messages.map(formatMessage));

  // Warmup call if first request since boot
  if (!ollamaWarmedUp) {
    try {
      await fetch(ollamaBaseUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          keep_alive: "30m",
          stream: false,
          messages: [{ role: "user", content: "ok" }],
          options: { num_ctx: 8192 }
        })
      });
      ollamaWarmedUp = true;
    } catch (e) {
      // ignore warmup errors
    }
  }

  const body = {
    model,
    messages: messages.map(formatMessage),
    stream: true,
    keep_alive: "30m",
    options: { num_ctx: 8192 },
    // (tools/tool_choice/temperature are not used by native /api/chat)
  };

  // Streaming handler with bounded backoff
  let resp: Response | undefined;
  const connectAC = new AbortController();
  let connectTimer: NodeJS.Timeout | undefined;
  const timeouts = [5000, 10000, 20000];
  let attempt = 0;
  let lastErr: any = undefined;
  for (; attempt < timeouts.length; ++attempt) {
    try {
      connectTimer = setTimeout(() => connectAC.abort(), timeouts[attempt]);
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: connectAC.signal,
      });
      clearTimeout(connectTimer);
      if (!resp.ok) {
        const txt = await resp.text();
        const content = `HTTP ${resp.status} – ${resp.statusText}\n${txt}`;
        console.error(content);
        return { role: "assistant", content };
      }
      // Wait for first chunk with timeout
      let reader = resp.body!.getReader();
      const decoder = new TextDecoder("utf-8");
      let gotFirstChunk = false;
      let firstChunkTimeout: NodeJS.Timeout;
      let firstChunkPromise = reader.read();
      let result: ReadableStreamReadResult<Uint8Array> | undefined;
      let timedOut = false;
      let p = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        firstChunkTimeout = setTimeout(() => {
          timedOut = true;
          try { reader.cancel(); } catch {}
          reject(new Error("first-chunk-timeout"));
        }, timeouts[attempt]);
        firstChunkPromise.then((r) => {
          if (!timedOut) {
            clearTimeout(firstChunkTimeout);
            resolve(r);
          }
        }).catch((e) => {
          clearTimeout(firstChunkTimeout);
          reject(e);
        });
      });
      result = await p;
      // If we got a chunk, rewind the stream for normal consumption
      // (not possible with native streams, so pass reader/result to main loop)
      // Patch below: reader/result are reused
      // Success: break out of retry loop
      // Patch: pass reader/result/decoder to chunk loop
      // Use a label to break out
      resp._org_firstChunk = result;
      resp._org_reader = reader;
      resp._org_decoder = decoder;
      break;
    } catch (e) {
      lastErr = e;
      clearTimeout(connectTimer);
      if (attempt < timeouts.length - 1) {
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, timeouts[attempt]));
      }
    }
  }
  if (!resp || resp._org_firstChunk === undefined) {
    // All retries failed
    return {
      role: "assistant",
      content: "Model is warming or unavailable, please retry later"
    };
  }

  /* -----------------------------------------------------------
     Parse the SSE / chunked response:
     Each chunk is a line:  data: { ...delta... }\n
     Last line:            data: [DONE]
  ------------------------------------------------------------ */
  let reader = resp._org_reader;
  const decoder = resp._org_decoder;
  let firstRead = true;
  let firstReadResult: ReadableStreamReadResult<Uint8Array> = resp._org_firstChunk;

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
