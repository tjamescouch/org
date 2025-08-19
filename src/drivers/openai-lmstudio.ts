import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types";

export interface OpenAiDriverConfig {
  baseUrl: string; // e.g. http://127.0.0.1:11434
  model: string;   // e.g. openai/gpt-oss-20b
  timeoutMs?: number; // default 45s
}

/**
 * Minimal OpenAI-compatible chat driver for LM Studio / OpenAI-style endpoints.
 * Adds an AbortController timeout so requests can’t hang the app.
 */
export function makeLmStudioOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const defaultTimeout = cfg.timeoutMs ?? 45_000;

  async function postChat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    try {
      const payload: any = {
        model: (opts?.model || cfg.model),
        messages: messages.map(m => {
          const out: any = { role: m.role, content: m.content };
          if (m.role === "tool") {
            if ((m as any).tool_call_id) out.tool_call_id = (m as any).tool_call_id;
            if ((m as any).name) out.name = (m as any).name;
          }
          return out;
        }),
        temperature: 0.2,
      };
      if (opts?.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
        payload.tools = opts.tools;
        payload.tool_choice = "auto";
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LM Studio / OpenAI chat failed (${res.status}): ${text}`);
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

  return { chat: postChat };
}
