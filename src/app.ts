#!/usr/bin/env bun
import { Agent } from './agent';
import { MockProvider } from './provider';
import { RoundRobinScheduler } from './scheduler';
import { InputController } from './input';
import { Logger } from './logger';

function parseAgentsArg(arg?: string): Array<{id:string, model:string}> {
  const list = (arg || 'alice:mock,bob:mock').split(',').map(s => s.trim()).filter(Boolean);
  return list.map(pair => {
    const [id, model] = pair.split(':').map(x => x.trim());
    return { id: id || 'agent', model: model || 'mock' };
  });
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let agentsArg: string | undefined;
  let maxTools = 2;
  for (let i=0; i<argv.length; i++) {
    const a = argv[i];
    if (a === '--agents' && argv[i+1]) { agentsArg = argv[++i]; }
    else if ((a === '--max-tools' || a === '-n') && argv[i+1]) { maxTools = Math.max(0, parseInt(argv[++i],10)); }
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: bun run src/app.ts [--agents "alice:mock,bob:mock"] [--max-tools 2]
Keys:
  i          Interject (pause agents, enter a new prompt, resume)
  Ctrl+C     Quit
`);
      process.exit(0);
    }
  }
  return { agents: parseAgentsArg(agentsArg), maxTools };
}

async function main() {
  const { agents, maxTools } = parseArgs();
  const provider = new MockProvider();
  const agentObjs = agents.map(({id, model}) => new Agent(id, model, provider));

  const sched = new RoundRobinScheduler(agentObjs, maxTools);

  // NEW: wire agent -> scheduler speak callback
  for (const a of agentObjs) {
    a.setOnSpeak((fromId, text) => sched.speak(fromId, text));
  }

  const input = new InputController(sched);

  await input.askInitial();
  await Promise.race([
    sched.start(),
  ]);
}

main().catch(err => { Logger.error(err); process.exit(1); });
