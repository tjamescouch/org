import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types";

export interface OpenAiDriverConfig {
  baseUrl: string; // e.g. http://192.168.56.1:11434
  model: string;   // e.g. openai/gpt-oss-120b
}

/**
 * Minimal OpenAI-compatible chat driver for LM Studio.
 * Uses POST /v1/chat/completions
 */
export function makeLmStudioOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;

  return {
    async chat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput> {
      const payload: any = {
        model: opts?.model || cfg.model,
        messages: messages.map(m => {
          const out: any = { role: m.role, content: m.content };
          if (m.role === "tool") {
            // OpenAI requires tool_call_id for tool responses
            if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
            if (m.name) out.name = m.name;
          }
          return out;
        }),
        temperature: 0.2
      };

      if (opts?.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
        payload.tools = opts.tools;
        payload.tool_choice = "auto";
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
    }
  };
}
