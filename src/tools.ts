import type { ToolCall, ToolResult } from './types';

export interface Tool {
  name: string;
  run(args: Record<string, any>): Promise<ToolResult>;
}

export class EchoTool implements Tool {
  name = 'echo';
  async run(args: Record<string, any>): Promise<ToolResult> {
    const text = typeof args.text === 'string' ? args.text : JSON.stringify(args);
    return { name: this.name, content: text };
  }
}

export class DateTool implements Tool {
  name = 'date';
  async run(): Promise<ToolResult> {
    return { name: this.name, content: new Date().toISOString() };
  }
}

export class CalcTool implements Tool {
  name = 'calc';
  async run(args: Record<string, any>): Promise<ToolResult> {
    const expr = String(args.expr ?? '');
    try {
      // very basic, do not expose in production
      // eslint-disable-next-line no-new-func
      const val = Function(`return (${expr})`)();
      return { name: this.name, content: String(val) };
    } catch (e: any) {
      return { name: this.name, content: `error: ${e?.message || String(e)}` };
    }
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(t: Tool) { this.tools.set(t.name, t); return this; }
  get(name: string): Tool | undefined { return this.tools.get(name); }
  async exec(call: ToolCall): Promise<ToolResult> {
    const t = this.get(call.name);
    if (!t) return { name: call.name, content: `unknown tool: ${call.name}` };
    return t.run(call.args || {});
  }
}

export const defaultRegistry = new ToolRegistry()
  .register(new EchoTool())
  .register(new DateTool())
  .register(new CalcTool());

