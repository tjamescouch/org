// src/recipes.ts
export type Recipe = {
  name: string;
  description: string;
  // System prompt injected for the primary agent
  system: string;
  // Initial user message if the CLI doesn't supply one
  kickoff?: string;
  // Optional tool allowlist; omit => all registered tools available
  allowTools?: string[];
  // Optional run budgets to keep flows bounded
  budgets?: { maxHops?: number; maxTools?: number; timeoutMs?: number };
};

export const RECIPES: Record<string, Recipe> = {
  fix: {
    name: "fix",
    description: "Turn red tests green with minimal patches.",
    system:
`You are a precise code repair assistant.
- Run tests, read the FIRST failure.
- Propose the smallest diff that fixes it.
- Explain in one paragraph why it's correct.
- Prefer surgical edits; never rewrite style wholesale.
- After applying, re-run tests. Stop when green.`,
    kickoff: "Please run the test suite and fix the first failing test.",
    allowTools: ["sh", "apply_patch", "git"], // narrow and safe
    budgets: { maxHops: 12, maxTools: 10, timeoutMs: 10 * 60_000 }
  },

  docs: {
    name: "docs",
    description: "Produce ARCHITECTURE.md with Mermaid diagram.",
    system:
`You are a repo documenter. Inventory modules and dependencies.
Emit an ARCHITECTURE.md with a Mermaid graph and brief section per module.`,
    kickoff: "Generate ARCHITECTURE.md at the repo root.",
    allowTools: ["sh", "apply_patch"]
  },

  review: {
    name: "review",
    description: "Propose patch; let user review with vimdiff before applying.",
    system:
`Propose a unified diff for the requested change.
Wait for a human review; only apply after they accept.`,
    kickoff: "Propose a minimal patch for the described change.",
    allowTools: ["apply_patch", "sh", "git"]
  },

  team: {
    name: "team",
    description: "Architect/Implementer/Tester round-robin.",
    system:
`You are part of a 3-role team. Output a brief step plan first.
Then implement one step at a time, asking the tester to run tests.`,
    kickoff: "Start with a 3-step plan; then propose first patch.",
    allowTools: ["apply_patch", "sh", "git"],
    budgets: { maxHops: 18, maxTools: 14 }
  },
};

// Helper
export function getRecipe(name?: string | null): Recipe | null {
  if (!name) return null;
  const key = String(name).toLowerCase();
  return RECIPES[key] ?? null;
}
