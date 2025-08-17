export interface LlmConfig {
  driver: "lmstudio";
  protocol: "openai";
  baseUrl: string;
  model: string;
}

export interface AppConfig {
  llm: LlmConfig;
  cli: Record<string, string>;
}

function readEnv(name: string, fallback: string): string {
  const v =
    (globalThis as any).process?.env?.[name] ??
    ((globalThis as any).Bun ? (Bun.env as any)?.[name] : undefined);
  return (typeof v === "string" && v.length > 0) ? v : fallback;
}

/** Simple CLI parser: --key value. */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
      out[key] = val;
    }
  }
  return out;
}

export function loadConfig(): AppConfig {
  const argv = (globalThis as any).Bun ? Bun.argv.slice(2) : process.argv.slice(2);
  const cli = parseArgs(argv);

  const driver   = (cli["driver"]   ?? readEnv("LLM_DRIVER",   "lmstudio")) as "lmstudio";
  const protocol = (cli["protocol"] ?? readEnv("LLM_PROTOCOL", "openai"))   as "openai";
  const baseUrl  =  cli["base-url"] ?? readEnv("LLM_BASE_URL", "http://192.168.56.1:11434");
  const model    =  cli["model"]    ?? readEnv("LLM_MODEL",    "gpt-oss-20b");

  return {
    llm: { driver, protocol, baseUrl, model },
    cli
  };
}
