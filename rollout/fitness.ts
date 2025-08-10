import { ChatRoom } from "../chat-room";
import { createAgentsFor, type DeploymentColor } from "../agent-factory";

export interface FitnessResult {
  color: DeploymentColor;
  passed: boolean;
  metrics: Record<string, number | string | boolean>;
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

  return {
    color,
    passed: !jsonLeak,
    metrics: { jsonLeak },
    transcript: rec.log,
  };
}