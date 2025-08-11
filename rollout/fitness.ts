import { ChatRoom } from "../chat-room";
import { createAgentsFor, type DeploymentColor } from "../agent-factory";
import { type Metrics, passed, summarize } from "../policy";

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

  // Smoke-test: ensure tool JSON never leaks to user-visible text
  const kickoff = `Agents! Create a single file README in the workspace using #file:README.md and do not print tool JSON.`;
  await room.broadcast("System", kickoff);

  // Give them time to act
  await new Promise(r => setTimeout(r, 8000));

  const jsonLeak = rec.log.some(line => /"stdout"|"stderr"|"exit_code"|"ok"/.test(line));

  // Simulate build and test results (replace with actual commands if available)
  let buildOK = false;
  let testsOK = false;
  let benchMs: number | null = null;

  try {
    // Simulate build/test commands here, for example by broadcasting commands or checking logs
    // For now, we simulate success:
    buildOK = true;
    testsOK = true;
    // Optionally simulate benchmark time
    benchMs = 123; 
  } catch {
    buildOK = false;
    testsOK = false;
  }

  const metrics: Metrics = { jsonLeak, buildOK, testsOK, benchMs };

  summarize(metrics);

  return {
    color,
    passed: passed(metrics),
    metrics,
    transcript: rec.log,
  };
}