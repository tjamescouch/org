import { ChatRoom } from "../chat-room";
import { createAgentsFor, type DeploymentColor } from "../agent-factory";
import { passed, type Metrics, summarize } from "../policy";
import { sh, runMake, hasFile } from "../sh";

export interface FitnessResult {
  color: DeploymentColor;
  passed: boolean;
  metrics: Metrics;
  transcript: string[];
}

class RecorderModel {
  public id = "recorder";
  public log: string[] = [];
  onAttach() {}
  onDetach() {}
  async receiveMessage(msg: any) {
    const to = msg.recipient ? ` -> ${msg.recipient}` : "";
    this.log.push(`${msg.seq ?? "?"} ${msg.from}${to}: ${String(msg.content ?? "").slice(0,500)}`);
  }
}

export async function evaluate(color: DeploymentColor): Promise<FitnessResult> {
  const room = new ChatRoom();
  const { instances } = await createAgentsFor(color);
  const rec = new RecorderModel();
  room.addModel(rec as any);
  for (const m of instances) room.addModel(m);

  // Concrete, verifiable kickoff task for agents
  const kickoff = `
You must deliver a verifiable C++ utility with tests and a tiny benchmark.

TASK: Implement wclite — counts lines, words, bytes for a file (subset of wc).
REQUIREMENTS
- Build: make produces wclite (no warnings).
- Usage: ./wclite <path> prints: lines=<n> words=<n> bytes=<n>\\n
- Tests: bash tests/run.sh passes (≥5 cases; empty, ascii text, long line, unicode bytes, larger file stub).
- Benchmark: bash bench/bench.sh prints median_ms=<number>.
- Do not print raw tool JSON in chat.
`;
  await room.broadcast("System", kickoff);

  // Allow agents to work
  await new Promise(r => setTimeout(r, 12000));

  // Metric 1: JSON leak in visible chat
  const jsonLeak = rec.log.some(line => /"stdout"|"stderr"|"exit_code"|"ok"/.test(line));

  // Metric 2: Build
  let buildOK = false;
  if (await hasFile("Makefile")) {
    const b = await runMake(".");
    buildOK = (b.code === 0);
  } else if (await hasFile("src/wclite.cpp")) {
    const b = await sh("bash", ["-lc", "mkdir -p bin && g++ -O3 -Wall -Wextra -std=c++17 -Iinclude -o bin/wclite src/wclite.cpp"], { cwd: "." });
    buildOK = (b.code === 0);
  }

  // Metric 3: Tests (optional)
  let testsOK: boolean | null = null;
  if (await hasFile("tests/run.sh")) {
    const t = await sh("bash", ["tests/run.sh"], { cwd: "." });
    testsOK = (t.code === 0);
  }

  // Metric 4: Benchmark (optional)
  let benchMs: number | null = null;
  if (await hasFile("bench/bench.sh")) {
    const r = await sh("bash", ["bench/bench.sh"], { cwd: "." });
    const m = r.out.match(/median_ms=(\d+)/);
    if (m) benchMs = parseInt(m[1], 10);
  }

  const metrics: Metrics = {
    jsonLeak,
    buildOK,
    testsOK,
    benchMs,
  };

  // Compact summary for rollout logs
  console.log(`${color.toUpperCase()} ${summarize(metrics)}`);

  return {
    color,
    passed: passed(metrics),
    metrics,
    transcript: rec.log,
  };
}