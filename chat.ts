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

const formatMessage = (message: ChatMessage): any => {
  return {
    ...message,
    content: `${message.role === 'assistant' ? '' :  `${message.from}: `}${message.content}`,
  };
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
  const url = `${opts?.baseUrl ?? BASE_URL}/v1/chat/completions`;

  // Install model-provided abort detectors (if any)
  if (opts?.abortDetectors && Array.isArray(opts.abortDetectors)) {
    abortRegistry.set(opts.abortDetectors);
  } else {
    abortRegistry.set([]); // default: no detectors
  }

  if (VERBOSE) console.error(messages.map(formatMessage));

  const body = {
    model: opts?.model ?? MODEL,
    messages: messages.map(formatMessage),
    tools: opts?.tools ?? [],
    tool_choice: opts?.tool_choice ?? (opts?.tools ? "auto" : undefined),
    temperature: opts?.temperature ?? 0.2,
    stream: true, 
  };

  // Connection timeout: abort if we can't connect quickly
  const connectAC = new AbortController();
  const connectTimer = setTimeout(() => connectAC.abort(), 5_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: connectAC.signal, // fast-fail on connect
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!resp.ok) {
    const txt = await resp.text();
    const content = `HTTP ${resp.status} – ${resp.statusText}\n${txt}`;
    console.error(content);
    return { role: "assistant", content }; // degraded msg
  }

  /* -----------------------------------------------------------
     Parse the SSE / chunked response:
     Each chunk is a line:  data: { ...delta... }\n
     Last line:            data: [DONE]
  ------------------------------------------------------------ */
  let reader = resp.body!.getReader();
  const decoder = new TextDecoder("utf-8");

  // Idle+hard-stop watchdogs to prevent hangs
  const IDLE_MS = 15_000;     // abort if no chunks for 15s
  const HARD_STOP_MS = 120_000; // absolute cap on streaming
  const startedAt = Date.now();

  async function readWithIdleTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
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
      if (!line.startsWith("data:")) continue;

      if(!namePrinted) {
        console.log(`\n\n**** ${name}:`);
        namePrinted = true;
      }

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as {
          choices: { delta: any; }[];
        };
        const delta = parsed.choices?.[0]?.delta ?? {};

        if (delta.reasoning) {
          if(firstThink) {
            firstThink = false;
            console.log("<think>");
          }
          Bun.stdout.write(delta.reasoning);
        } else if (delta.content) { 
          if(firstNotThink && !firstThink) {
            firstNotThink = false;
            console.log("\n</think>\n");
          }
        } else {
          if(firstNotThink && !firstThink) {
            firstNotThink = false;
            console.log("\n</think>\n");
          }
        }

        Bun.stdout.write(delta.content);

        if (delta.content) contentBuf += delta.content;
        if (delta.reasoning) thinkingBuf += delta.reasoning;
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
