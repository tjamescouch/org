<file name=chat-room.ts>
// chat-room.ts
// ... existing imports and code ...

export class ChatRoom {
  // ... existing properties and methods ...

  async broadcast(from: string, content: string) {
    try { (globalThis as any).__log?.(`[room] broadcast from ${from} len=${(content||'').length}`, "gray"); } catch {}
    const modelsList = Array.from(this.models?.keys?.() ?? []);
    try { (globalThis as any).__log?.(`[room] recipients: ${modelsList.join(', ') || '(none)'}`, "gray"); } catch {}

    const msg = { from, content, timestamp: Date.now() };
    for (const model of this.models.values()) {
      try { (globalThis as any).__log?.(`[room] → deliver to ${model.id || model.name}`, "gray"); } catch {}
      try {
        await this.safeDeliver(model, msg);
        try { (globalThis as any).__log?.(`[room] ← delivered to ${model.id || model.name}`, "gray"); } catch {}
      } catch (e) {
        try { (globalThis as any).__logError?.(`[room] delivery error to ${model.id || model.name}: ${String(e)}`); } catch {}
      }
    }
  }

  // ... rest of ChatRoom class ...
}
</file>

<file name=agent-model.ts>
// agent-model.ts
// ... existing imports and code ...

export class AgentModel {
  id: string;
  model: string;
  // ... other properties ...

  async receiveMessage(incoming: RoomMessage) {
    try { (globalThis as any).__log?.(`[agent:${this.id}] receiveMessage role=${incoming.role} from=${incoming.from} len=${(incoming.content||'').length}`, "cyan"); } catch {}

    // ... existing code to build fullMessageHistory and tools ...

    try { (globalThis as any).__log?.(`[agent:${this.id}] invoking model ${this.model} with ${fullMessageHistory.length} msgs`, "cyan"); } catch {}
    const messages = await this.runWithTools(fullMessageHistory, tools, (c) => this._execTool(c), 25);

    // ... rest of receiveMessage ...
  }

  async runWithTools(messages: Message[], tools: Tool[], execTool: (c: any) => Promise<any>, maxTokens: number) {
    try { (globalThis as any).__log?.(`[agent:${this.id}] runWithTools enter`, "gray"); } catch {}

    // ... existing code to chatOnce and assign to msg ...

    const msg = await this.chatOnce(messages, maxTokens);

    try { (globalThis as any).__log?.(`[agent:${this.id}] model reply: contentLen=${(msg?.content||'').length} tools=${Array.isArray(msg?.tool_calls)?msg.tool_calls.length:0}`, "gray"); } catch {}

    // ... rest of runWithTools ...
  }

  // ... rest of AgentModel class ...
}
</file>