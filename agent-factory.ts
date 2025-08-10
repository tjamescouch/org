import { readFileSync } from "fs";

export type DeploymentColor = "blue" | "green";

function readActive(): DeploymentColor {
  try {
    const raw = readFileSync("./deployment.json", "utf-8");
    const cfg = JSON.parse(raw);
    return (cfg.active === "green" ? "green" : "blue");
  } catch {
    return "blue";
  }
}

/** Create the three agents for the given color explicitly. */
export async function createAgentsFor(color: DeploymentColor) {
  const mod = color === "blue"
    ? await import("./agent-model")
    : await import("./agents/green/agent-model");

  const { AgentModel } = mod as { AgentModel: new (id: string) => any };
  const alice = new AgentModel("alice");
  const bob   = new AgentModel("bob");
  const carol = new AgentModel("carol");
  return { AgentModel, instances: [alice, bob, carol] };
}

/** Create agents using the deployment.json active color. */
export async function createAgents() {
  const active = readActive();
  return createAgentsFor(active);
}