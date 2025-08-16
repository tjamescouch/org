// transport/chat.ts
// Portable streaming client used by AgentModel. Supports `onData` to let callers
// refresh leases while tokens arrive. Avoids Node/Bun specifics.

import { logLine } from "../core/entity/agent-model";
import Logger from "../ui/logger";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; from?: string; content?: string; read?: boolean };
export type AbortDetector = any;

export interface ChatOptions {
  model?: string;
  tools?: any[];
  tool_choice?: "auto" | "none";
  num_ctx?: number;
  abortDetectors?: AbortDetector[];
  soc?: string;
  temperature?: number;
  /** Streaming data callback. Called for every chunk. */
  onData?: (chunk: string) => void;
  /** Base URL override; otherwise inferred from env. */
  baseUrl?: string;
  /** Force non-streaming request. */
  noStream?: boolean;
}

let _abort: AbortController | null = null;
export function interruptChat() {
  try { _abort?.abort(); } catch { /* noop */ }
}

export interface ChatResult {
  id: string,
  object: string,
  created: number,
  model: string,
  system_fingerprint: string,
  choices: [{
    index: number,
    delta: { reasoning?: string, content?: string },
    logprobs: string,
    finish_reason: string
  }
  ]
}

export const parseChatData = (s: string): ChatResult | undefined => {
  try {
    JSON.parse(s);
  } catch {
    return undefined;
  }
}
export const parseChatDatas = (s: string): string => {
  return s.split("data: ").map(blob => parseChatData(blob)).flatMap(x => x?.choices).map(c => (c?.delta.content || c?.delta.reasoning || '')).join('');
}

function pickBaseUrl(defaultBase?: string): string | undefined {
  const env: any = (globalThis as any).process?.env ?? {};
  return defaultBase || env.OLLAMA_BASE_URL || env.OAI_BASE || env.OPENAI_BASE_URL || env.OPENAI_BASE || undefined;
}

const isTrue = (s: string): boolean => {
  return s === "true" || s === "1";
}

function isOpenAi(url: string): boolean {
  return isTrue(process.env.OPENAI_COMPATIBLE) || true;
}

type StringToVoid = (s: string) => void;

export async function chatOnce(agentId: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<any> {
  const base = pickBaseUrl(opts.baseUrl) || "http://127.0.0.1:11434";
  const url = base.replace(/\/$/, "");
  const endpoint = isOpenAi(url) ? "/v1/chat/completions" : "/chat";

  _abort = new AbortController();

  const body: any = {
    model: opts.model || "gpt-oss-20b",
    messages,
    stream: !opts.noStream,
    tools: opts.tools || undefined,
    tool_choice: opts.tool_choice || undefined,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 1,
    num_ctx: opts.num_ctx || 8192,
    meta: { soc: opts.soc || "" },
  };

  const res = await fetch(url + endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: _abort.signal,
  });

  if (!res.ok) {
    return { role: "assistant", content: `${res.status} — Not Found` };
  }

  if (opts.noStream) {
    const text = await res.text();

    Logger.streamInfo(text);

    return { role: "assistant", content: text };
  }

  const reader: any = (res as any).body?.getReader ? (res as any).body.getReader() : null;
  const decoder = new TextDecoder();
  let buffered = "";
  let finalText = "";
  let toolCalls: any[] = [];

  if (!reader) {
    // Non-streaming body; consume all
    const text = await res.text();
    opts.onData?.(text);
    return { role: "assistant", content: text };
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    opts.onData?.(chunk);
    buffered += chunk;

    Logger.info(chunk);

    // Parse SSE-style "data: ..." lines if present
    let idx: number;
    while ((idx = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, idx).trim();
      buffered = buffered.slice(idx + 1);
      if (!line) continue;
      const m = /^data:\s*(.*)$/i.exec(line);
      if (m) {
        const payload = m[1];
        if (payload === "[DONE]") { buffered = ""; break; }
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices[0].delta.content;
          if (delta) {
            finalText += delta;
          }
          if (Array.isArray(obj?.choices?.[0]?.delta?.tool_calls)) {
            toolCalls = toolCalls.concat(obj.choices[0].delta.tool_calls);
          }
        } catch {
          finalText += payload;
        }
      } else {
        finalText += line;
      }
    }
  }

  if (buffered.trim().length) {
    finalText += buffered.trim();
  }

  return { role: "assistant", content: finalText, tool_calls: toolCalls.length ? toolCalls : undefined };
}

export async function summarizeOnce(messages: ChatMessage[], opts: ChatOptions = {}, onData?: StringToVoid): Promise<string> {
  const base = pickBaseUrl(opts.baseUrl) || "http://127.0.0.1:11434";
  const url = base.replace(/\/$/, "");
  const endpoint = "/summarize";

  const res = await fetch(url + endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model || "gpt-oss-20b", messages }),
  });
  if (!res.ok) return "";
  const text = await res.text();

  if(onData) onData(text);

  return text;
}
