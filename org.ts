#!/usr/bin/env bun
// org.ts — CLI entry point for the multi‑agent chat application.
//
// Usage patterns:
//   bun org.ts                    # interactive TUI (if stdout/stderr are TTYs)
//   bun org.ts --prompt "Hello"   # non‑interactive script mode; run prompt once
//   bun org.ts --prompt "..." --personas "alice#model#[extra],bob#otherModel"  # custom agents
//   bun org.ts --safe --prompt "..."   # prompt for Enter before each agent runs
//   echo "hi" | bun org.ts       # reads stdin as prompt and runs in script mode

import { ChatRoom } from './src/core/chat-room';
import { TurnManager } from './src/core/turn-manager';
import { AgentModel } from './src/core/entity/agent-model';

// Attempt to import the interactive TUI.  When INTERACTIVE is true,
// we will call this module's default export instead of running script
// mode.  It must be imported lazily so that environment variables set
// above are visible to the transport layer.
const interactiveApp = () => require('./src/orchestration/app.ts');

// Simple logger for this CLI.  We intentionally avoid importing the
// application-wide Logger here to keep CLI output uncluttered.
function cliLog(msg: string) {
  process.stdout.write(msg + '\n');
}

// Parse command‑line arguments.  Returns a map of flags and values.
function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, val] = arg.split('=', 2);
      const flag = key.replace(/^--/, '');
      if (val !== undefined) {
        opts[flag] = val;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          opts[flag] = next;
          i++;
        } else {
          opts[flag] = true;
        }
      }
    } else if (arg.startsWith('-')) {
      // short flags: -s => safe
      const letters = arg.slice(1).split('');
      for (const letter of letters) {
        switch (letter) {
          case 's':
            opts.safe = true;
            break;
        }
      }
    }
  }
  return opts;
}

// Parse persona specification string into an array of objects.
interface PersonaSpec { name: string; model: string; extra: string; }
function parsePersonas(str: string | undefined, defaultModel: string): PersonaSpec[] {
  if (!str) return [];
  return str.split(/\s*,\s*/).filter(Boolean).map(token => {
    const [name, model, extra] = token.split('#');
    return {
      name: name,
      model: model || defaultModel,
      extra: extra || '',
    };
  });
}

// Pause for Enter when safe mode is enabled.  Returns a promise that
// resolves once the user presses Enter.  If stdin is not a TTY this
// resolves immediately.
function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise(resolve => {
    process.stdout.write('Press Enter to continue...');
    process.stdin.resume();
    process.stdin.once('data', () => {
      resolve();
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  // Determine interactive mode.  If no --prompt and stdin is a TTY, go
  // interactive; otherwise run in script mode.
  const interactive = !opts.prompt && process.stdin.isTTY && process.stdout.isTTY;

  if (interactive) {
    // Defer to existing TUI.  It will handle its own argument parsing.
    interactiveApp();
    return;
  }

  // Determine the prompt.  Use --prompt if provided, otherwise read
  // everything from stdin.  Trim trailing newlines.
  let prompt: string | null = null;
  if (typeof opts.prompt === 'string') {
    prompt = String(opts.prompt);
  } else {
    // read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString('utf-8').trim();
  }
  if (!prompt) {
    cliLog('No prompt provided');
    return;
  }

  // Determine personas.  The default model can be passed via
  // --default-model or fallback to environment variables.
  const defaultModel = String(opts['default-model'] || process.env.OLLAMA_MODEL || process.env.OAI_MODEL || 'openai/gpt-oss-20b');
  let personas = parsePersonas(opts.personas as string | undefined, defaultModel);
  if (personas.length === 0) {
    // Provide two default agents if none specified
    personas = [
      { name: 'alice', model: defaultModel, extra: '' },
      { name: 'bob',   model: defaultModel, extra: '' },
    ];
  }

  const safe: boolean = !!opts.safe;

  // Create chat room and agents
  const room = new ChatRoom();
  const agents: AgentModel[] = [];
  for (const p of personas) {
    const agent = new AgentModel(p.name, p.model);
    // Append any extra system prompt if provided.  We do this by
    // modifying the agent's system prompt string directly.  This
    // approach avoids modifying the AgentModel constructor.
    if (p.extra) {
      (agent as any).system = (agent as any).system + '\n' + p.extra;
    }
    agents.push(agent);
    room.addModel(agent as any);
  }

  // Kick off conversation: send a user message
  await room.broadcast('User', prompt);

  // For each agent, optionally wait for user confirmation in safe mode
  for (const agent of agents) {
    if (safe) {
      await waitForEnter();
    }
    await (agent as any).takeTurn();
  }

  // Collect outputs by hooking into ChatRoom.broadcast.  We monkey patch
  // broadcast, run the agents again on the prompt, and capture the
  // assistant messages.  This ensures we capture outputs even if
  // multiple broadcasts occur per agent.
  const transcripts: Array<{from: string; content: string}> = [];
  const origBroadcast = (ChatRoom.prototype as any).broadcast;
  (ChatRoom.prototype as any).broadcast = async function(from: string, content: string, directTo?: string) {
    if (from !== 'User') transcripts.push({ from, content });
    return origBroadcast.call(this, from, content, directTo);
  };

  // Send prompt again to ensure transcripts capture this run
  await room.broadcast('User', prompt);
  for (const agent of agents) {
    if (safe) await waitForEnter();
    await (agent as any).takeTurn();
  }

  // Restore broadcast
  (ChatRoom.prototype as any).broadcast = origBroadcast;

  // Print outputs: show each assistant message on its own line
  for (const t of transcripts) {
    cliLog(`${t.from}: ${t.content}`);
  }
}

main().catch(err => {
  console.error(err);
});