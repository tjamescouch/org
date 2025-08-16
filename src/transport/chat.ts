// transport/chat.ts
// Streaming chat transport with optional onData hook so callers can refresh a lease (e.g., ChannelLock.touch()).
// This module avoids Node/Bun specifics and relies on the Fetch standard + Web Streams.
// It also exposes `interruptChat()` to abort the in-flight request.

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; from?: string; content?: string; read?: boolean };
export type ToolCall = any;
export type AbortDetector = any;

export interface ChatOptions {
  model?: string;
  tools?: any[];
  tool_choice?: "auto" | "none";
  num_ctx?: number;
  abortDetectors?: AbortDetector[];
  soc?: string;
  temperature?: number;
  /** Called with raw streamed data chunks as they arrive. */
  onData?: (chunk: string) => void;
  /** Override baseUrl (e.g., OLLAMA_BASE_URL, OpenAI base, mock base). */
  baseUrl?: string;
  /** When true, disable streaming. */
  noStream?: boolean;
}

let _abort: AbortController | null = null;
export function interruptChat() {
  try { _abort?.abort(); } catch { /* noop */ }
}

function pickBaseUrl(defaultBase?: string): string | undefined {
  const env: any = (globalThis as any).process?.env ?? {};
  return defaultBase || env.OLLAMA_BASE_URL || env.OAI_BASE || env.OPENAI_BASE_URL || env.OPENAI_BASE || undefined;
}

/**
 * Minimal streaming client compatible with both OpenAI-style streaming (data: lines)
 * and simple text endpoints used in tests. The exact wire format is intentionally
 * lightweight; the important bit is that we invoke `opts.onData` for every
 * streamed token/chunk so upper layers can call ChannelLock.touch().
 */
export async function chatOnce(agentId: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<any> {
  const base = pickBaseUrl(opts.baseUrl) || "http://127.0.0.1:11434";
  const url = base.endsWith("/") ? base.slice(0, -1) : base;

  const body = {
    model: opts.model || "gpt-oss-20b",
    messages,
    stream: !opts.noStream,
    tools: opts.tools || undefined,
    tool_choice: opts.tool_choice || undefined,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 1,
    num_ctx: opts.num_ctx || 8192,
    // Allow servers to receive raw SoC if they support it (safe to ignore).
    meta: { soc: opts.soc || "" }
  };

  _abort = new AbortController();

  // Prefer `/v1/chat/completions` if it looks like an OpenAI base, otherwise fall back
  // to a generic `/chat` the mock servers can implement.
  const endpoint = /openai|api\.openai|v1|chat/i.test(url) ? "/v1/chat/completions" : "/chat";

  const res = await fetch(url + endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: _abort.signal,
  });

  if (!res.ok) {
    return { role: "assistant", content: `${res.status} — Not Found` };
  }

  if (opts.noStream) {
    const text = await res.text();
    return { role: "assistant", content: text };
  }

  const reader = (res.body as any).getReader?.();
  if (!reader) {
    // No reader means no streaming support; read everything.
    const text = await res.text();
    return { role: "assistant", content: text };
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let finalText = "";
  let toolCalls: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buffered += chunk;
    opts.onData?.(chunk);

    // Parse Server-Sent-Events style "data: ..." lines if present
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
          if (obj?.choices?.[0]?.delta?.content) {
            finalText += obj.choices[0].delta.content;
          }
          if (Array.isArray(obj?.choices?.[0]?.delta?.tool_calls)) {
            toolCalls = toolCalls.concat(obj.choices[0].delta.tool_calls);
          }
        } catch {
          // Non-JSON payload: treat as plain text
          finalText += payload;
        }
      } else {
        // Non-SSE line — accumulate as text
        finalText += line;
      }
    }
  }

  // Flush any remaining buffered text as plain text
  if (buffered.trim().length) {
    finalText += buffered.trim();
  }

  return { role: "assistant", content: finalText, tool_calls: toolCalls.length ? toolCalls : undefined };
}

export async function summarizeOnce(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  // Non-streaming, simple summary endpoint
  const base = pickBaseUrl(opts.baseUrl) || "http://127.0.0.1:11434";
  const url = base.endsWith("/") ? base.slice(0, -1) : base;
  const endpoint = "/summarize";

  const res = await fetch(url + endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model || "gpt-oss-20b", messages }),
  });
  if (!res.ok) return "";
  return await res.text();
}
