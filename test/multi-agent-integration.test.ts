// High‑level integration test that spins up a temporary mock server and
// verifies that multiple agents respond when using the mock provider.
//
// The test starts a Node.js HTTP server that implements the endpoints
// expected by the chat transport layer: `/api/version`, `/api/tags`, and
// `/v1/chat/completions`.  Each chat completion returns a deterministic
// assistant message (`"ok"`).  The test overrides the environment
// variables used by the transport (`OLLAMA_BASE_URL` and `OLLAMA_MODEL`)
// before importing any project code.  It then creates a `ChatRoom` with
// two agents (`alice` and `bob`), broadcasts a greeting from the User,
// runs the `TurnManager` for a few seconds, and asserts that both agents
// responded at least once.

// Choose a port for the mock server up front and set environment variables
// BEFORE importing project modules.  The transport layer reads these
// variables at import time, so they must be defined here.  Ports in the
// 8000–9000 range are typically free on test machines.
const MOCK_PORT = 8800 + Math.floor(Math.random() * 1000);
process.env.OLLAMA_BASE_URL = `http://localhost:${MOCK_PORT}`;
process.env.OLLAMA_MODEL = 'mock';

import { ChatRoom } from '../src/core/chat-room';
import { TurnManager } from '../src/core/turn-manager';
import { AgentModel } from '../src/core/entity/agent-model';
import * as http from 'http';

async function run(): Promise<void> {
  // Provide a minimal Bun stub when running under Node.js so that any
  // Bun‑specific code in the project doesn’t explode.  When run under
  // Bun, this is ignored because globalThis.Bun is already defined.
  if (!(globalThis as any).Bun) {
    (globalThis as any).Bun = {
      stdout: { write: (_chunk: any) => {} },
      stderr: { write: (_chunk: any) => {} },
    } as any;
  }

  // Create a simple HTTP server to mock the chat provider.  It returns
  // deterministic data for the preflight endpoints and the chat
  // completions endpoint.  Each completion returns an assistant message
  // with content "ok".
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: 'mock' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const response = {
          choices: [ { message: { role: 'assistant', content: 'ok' } } ],
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });
  await new Promise<void>(resolve => server.listen(MOCK_PORT, resolve));

  // Monkey‑patch ChatRoom.broadcast to capture all messages sent by the
  // agents.  The TurnManager uses broadcast to deliver assistant
  // responses, so we can see who spoke.
  const transcripts: Array<{from: string; content: string}> = [];
  const origBroadcast = (ChatRoom.prototype as any).broadcast;
  (ChatRoom.prototype as any).broadcast = async function(from: string, content: string, directTo?: string) {
    transcripts.push({ from, content });
    return origBroadcast.call(this, from, content, directTo);
  };

  try {
    // Set up a chat room with two agents and start a conversation
    const room = new ChatRoom();
    const alice = new AgentModel('alice', 'mock');
    const bob   = new AgentModel('bob', 'mock');
    room.addModel(alice as any);
    room.addModel(bob as any);
    // Send the initial user message to both agents
    await room.broadcast('User', 'Hello agents');
    // Start the turn manager to schedule agents
    const tm = new TurnManager(room, [alice as any, bob as any], {
      tickMs: 200,
      idleBackoffMs: 100,
      proactiveMs: 200,
      turnTimeoutMs: 2000,
    });
    tm.start();
    // Allow some time for agents to respond
    await new Promise(resolve => setTimeout(resolve, 3000));
    tm.stop();
    // Verify that both agents responded at least once
    const aliceSaid = transcripts.some(t => t.from === 'alice');
    const bobSaid   = transcripts.some(t => t.from === 'bob');
    if (!aliceSaid || !bobSaid) {
      throw new Error(`Agents did not both respond: transcripts=${JSON.stringify(transcripts)}`);
    }
  } finally {
    // Restore the original broadcast method
    (ChatRoom.prototype as any).broadcast = origBroadcast;
    // Close the mock server
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});