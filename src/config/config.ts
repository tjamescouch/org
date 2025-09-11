// src/config/config.ts
import { getRecipe } from "../recipes";
import { R } from "../runtime/runtime";

interface LlmConfig {
  driver: "lmstudio";
  protocol: "openai";
  baseUrl: string;
  model: string;
}

interface AppRuntime {
  safe: boolean;
}

interface AppConfig {
  llm: LlmConfig;
  runtime: AppRuntime;
  cli: Record<string, string>;
}

function readEnv(name: string, fallback: string): string {
  const v = R.env[name];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Parse CLI flags in a minimal, POSIX-friendly way.
 *  Supports:
 *   --key value     -> { key: "value" }
 *   --key=value     -> { key: "value" }
 *   --flag          -> { flag: "1" }
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;

    const eq = tok.indexOf("=");
    if (eq > 2) {
      // --key=value
      const key = tok.slice(2, eq);
      const val = tok.slice(eq + 1);
      out[key] = val;
      continue;
    }

    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "1"; // boolean flag present
    }
  }
  return out;
}

function parseBool(s: string | undefined, def = false): boolean {
  if (s == null) return def;
  const v = String(s).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function loadConfig(): AppConfig {
  const argv = R.argv.slice(2);
  const cli = parseArgs(argv);

  // ---- Recipe passthrough (optional) ----
  const recipeName = cli["recipe"];
  const recipe = getRecipe(recipeName ?? null);

  // Propagate recipe choice + budgets via env for downstream consumers.
  if (recipe?.name) (R.env as any).ORG_RECIPE = recipe.name;
  if (recipe?.budgets?.maxHops != null) (R.env as any).ORG_MAX_HOPS = String(recipe.budgets.maxHops);
  if (recipe?.budgets?.maxTools != null) (R.env as any).ORG_MAX_TOOLS = String(recipe.budgets.maxTools);
  if (recipe?.budgets?.timeoutMs != null) (R.env as any).ORG_TIMEOUT_MS = String(recipe.budgets.timeoutMs);

  // ---- LLM config (CLI overrides env; env overrides defaults) ----
  const driver = (cli["driver"] ?? readEnv("ORG_LLM_DRIVER", "lmstudio")) as "lmstudio";
  const protocol = (cli["protocol"] ?? readEnv("ORG_LLM_PROTOCOL", "openai")) as "openai";
  const baseUrl = cli["base-url"] ?? readEnv("ORG_LLM_BASE_URL", "http://192.168.5.2:11434");
  const model = cli["model"] ?? readEnv("ORG_LLM_MODEL", "openai/gpt-oss-120b");

  // ---- Runtime flags ----
  const safeFromCli = cli.hasOwnProperty("safe") ? cli["safe"] : undefined;
  const safeFlag = parseBool(safeFromCli ?? readEnv("SAFE_MODE", ""), false);

  return {
    llm: { driver, protocol, baseUrl, model },
    runtime: { safe: safeFlag },
    cli,
  };
}
