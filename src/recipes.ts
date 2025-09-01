// src/recipes.ts

type Recipe = {
  name: string;
  description: string;
  system: string;                  // system prompt text
  kickoff?: string;                // initial user instruction
  allowTools?: string[];           // optional tool allowlist
  budgets?: { maxHops?: number; maxTools?: number; timeoutMs?: number };
};

const RECIPES: Record<string, Recipe> = {
  fix: {
    name: "fix",
    description: "Turn red tests green with minimal patches.",
    system:
`You are a precise code repair assistant.
- Run tests, read the FIRST failure.
- Propose the smallest diff that fixes it.
- Explain in one paragraph why it's correct.
- Prefer surgical edits; never rewrite style wholesale.
- After applying, re-run tests. Stop when green.
- Return control of the conversation to the user when you complete the task by using the @@user tag`,
    kickoff: "Please run the test suite now and fix the first failing test.",
    allowTools: ["sh", "apply_patch", "git"],
    budgets: { maxHops: 12, maxTools: 10, timeoutMs: 10 * 60_000 },
  },

  docs: {
    name: "docs",
    description: "Produce ARCHITECTURE.md with a Mermaid diagram.",
    system:
`You are a repo documenter. Inventory modules and dependencies.
Emit ARCHITECTURE.md with a Mermaid graph and brief sections per module.`,
    kickoff: "Generate ARCHITECTURE.md at the repo root.",
    allowTools: ["sh", "apply_patch"],
  },

  review: {
    name: "review",
    description: "Propose a patch; human reviews with vimdiff before applying.",
    system:
`Propose a unified diff for the requested change.
Wait for human review; apply only after acceptance.`,
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
  },
};

export function getRecipe(name?: string | null): Recipe | null {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return RECIPES[key] ?? null;
}
