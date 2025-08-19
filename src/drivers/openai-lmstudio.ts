import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types";

/**
 * Minimal OpenAI-compatible driver for LM Studio / Ollama OpenAI endpoints.
 * Adds:
 *  - Request timeout via AbortController (default 45s)
 *  - Clear error messages
 */
export interface OpenAiDriverConfig {
  baseUrl: string;   // e.g. http://192.168.56.1:11434
  model: string;     // e.g. openai/gpt-oss-120b
  timeoutMs?: number;
}

export function makeLmStudioOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const defaultTimeout = cfg.timeoutMs ?? 45_000;

  async function postChat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    try {
      const payload: any = {
        model: (opts?.model ?? cfg.model),
        messages,
        temperature: 0.2,
      };
      if (opts?.tools && opts.tools.length) payload.tools = opts.tools;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LM Studio OpenAI /chat/completions failed (${res.status}): ${text}`);
      }

      const data: any = await res.json();
      const choice = data?.choices?.[0];
      const msg = choice?.message || {};
      const content = typeof msg?.content === "string" ? msg.content : "";
      const toolCalls: ChatToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

      return { text: content, toolCalls };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    chat: postChat
  };
}
