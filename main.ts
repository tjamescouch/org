// main.ts — Bun: keepalive via timer + graceful shutdown

import { ChatRoom } from "./chat-room";
import { createAgents } from "./agent-factory";

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException",  e => { console.error("[uncaughtException]", e); process.exitCode = 1; });

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function app() {
  const room = new ChatRoom();

  // Use AgentFactory to instantiate the active color (blue/green) agents
  const { instances } = await createAgents();
  for (const m of instances) room.addModel(m);

  // Hard-coded kickoff message (recursive self-improvement instructions)
  const initialMessage = `
  👓 Agents welcome! Let's get to work on a new and fun project - ourselves 😊! The project is called org and it's the cli agent orchestrator we live in. Always check for existing files the workspace. Bob - you will do the coding, please run and test the code you write. Your goal is to incrementally improve the system. Carol - you will do the architecture, please keep architecture documents and readme up-to-date. I will be the product person who makes the decisions
You are participating in a **recursive self-improvement sprint** using a blue/green-style candidate rollout.

ROLES
- Alice (coordinator): orchestrates the sprint and decisions.
- Bob (coder): writes and runs code; uses tools; keeps changes small and testable.
- Carol (architect/docs): maintains architecture decisions and README; reviews changes for soundness.

GROUND RULES (very important)
1) **No raw tool JSON in chat.** Never print { ok, stdout, stderr, exit_code } style blobs. Use tools internally, then summarize results in plain English.
2) **Use #file tags for edits.** When creating or updating files, write content via \`#file:<path>\` blocks; keep each file in a single fenced block.
3) **Use the shell tool sparingly** (\`sh\`) to compile/run/tests, but only summarize outputs in chat (no direct dumps).
4) Prefer frequent, small steps; each step must build and run.

BLUE/GREEN CANDIDATE FLOW (hard-coded for now)
- Treat the current checked-in implementation as **BLUE** (stable baseline).
- Develop the next iteration as **GREEN** (candidate). While we don’t yet swap factories here, keep all new or changed files consistent and self-contained so they can be toggled later.
- Carol defines a quick fitness checklist; Bob implements; Alice approves.

MINIMUM FITNESS (must pass before proposing promotion):
- \`g++\` (or \`make\`) builds without errors/warnings on default target.
- Unit or smoke tests run and pass.
- No tool-JSON appears in visible messages.
- \`README.md\` and \`architecture.md\` exist and match the current code.

INITIAL OBJECTIVE
- Brainstorm a small C++ utility that can be finished quickly (≤ 200 LOC), is easily testable, and demonstrates the tool-call loop (edit → build → run → refine). Examples: a minimal task list CLI, a text stats tool, or a Luhn checker with a tiny benchmark.
- Pick one, agree briefly, then **implement incrementally**:
  1) Carol drafts \`architecture.md\` (scope, modules, build plan).
  2) Bob scaffolds the code and \`Makefile\` (or a one-liner build command).
  3) Bob compiles and runs basic tests via shell tool; **summarize** results only.
  4) Carol updates docs as code evolves.
  5) Both ensure README shows build + usage.
  6) Put this subproject in the workspace directory.
  7) Then based on the results of the experiment make changes to your own source code such that the task could have been completed more optimally.
  8) Try to do things in the spirit of this experiment and not exploit or trick your way through.
- When fitness passes, propose a commit message: \`rollout: green candidate passes fitness\`.

REMINDERS
- Keep diffs small. After each tool run, respond with a short, human-readable summary, not raw logs.
- If a command fails, summarize the error and next step—don’t paste the full output.
`;

  // Find Alice among the instantiated agents and send the kickoff
  const alice = instances.find(a => (a as any).id === "alice");
  if (alice && typeof (alice as any).initialMessage === "function") {
    await (alice as any).initialMessage({
      role: "assistant",
      ts: Date.now().toString(),
      from: "alice",
      content: initialMessage,
      read: false,
    });
  }

  // Bun keepalive: a Promise alone won't keep runtime alive; hold a real handle
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);

  await waitForSignal();
  clearInterval(keepAlive);
  if (typeof (room as any).shutdown === "function") {
    await (room as any).shutdown();
  }
}

app().catch((e) => {
  console.error("App crashed:", e);
  process.exit(1);
});
