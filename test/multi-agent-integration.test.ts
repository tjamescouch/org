import { test } from 'bun:test';
import { ChatRoom } from '../src/core/chat-room';
import { TurnManager } from '../src/core/turn-manager';
import { AgentModel } from '../src/core/entity/agent-model';
import * as http from 'http';

test('multi-agent integration with mock server', async () => {
  // Provide a minimal Bun stub for Node.js
  if (!(globalThis as any).Bun) {
    (globalThis as any).Bun = {
      stdout: { write: (_chunk: any) => {} },
      stderr: { write: (_chunk: any) => {} },
    } as any;
  }

  // Start a mock HTTP server that returns deterministic replies
  const port = 6000 + Math.floor(Math.random() * 1000);
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
        // Parse the incoming payload to identify which agent invoked chatOnce
        // For our test we just return a generic reply.  The content could be
        // influenced by the request if desired.
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
  await new Promise<void>(resolve => server.listen(port, resolve));

  // Set environment variables to direct chatOnce() calls to our mock server
  process.env.OLLAMA_BASE_URL = `http://localhost:${port}`;
  process.env.OLLAMA_MODEL = 'mock';

  // Monkey-patch ChatRoom.broadcast to record all broadcasts
  const transcripts: Array<{from: string; content: string}> = [];
  const origBroadcast = (ChatRoom.prototype as any).broadcast;
  (ChatRoom.prototype as any).broadcast = async function(from: string, content: string, directTo?: string) {
    transcripts.push({ from, content });
    return origBroadcast.call(this, from, content, directTo);
  };

  // Create chat room and agents
  const room = new ChatRoom();
  const alice = new AgentModel('alice', 'mock');
  const bob   = new AgentModel('bob', 'mock');
  room.addModel(alice as any);
  room.addModel(bob as any);

  // Kick off conversation: send a user message to both
  await room.broadcast('User', 'Hello agents');

  // Start turn manager to schedule agents
  const tm = new TurnManager(room, [alice as any, bob as any], { tickMs: 200, idleBackoffMs: 100, proactiveMs: 200, turnTimeoutMs: 2000 });
  tm.start();

  // Wait some time for agents to respond
  await new Promise(resolve => setTimeout(resolve, 3000));

  tm.stop();

  // Restore original broadcast method
  (ChatRoom.prototype as any).broadcast = origBroadcast;

  // Shut down server
  await new Promise<void>(resolve => server.close(() => resolve()));

  // We expect at least one reply from both agents in the transcript
  const aliceSaid = transcripts.some(t => t.from === 'alice');
  const bobSaid   = transcripts.some(t => t.from === 'bob');
  if (!aliceSaid || !bobSaid) {
    throw new Error(`Agents did not both respond: transcripts=${JSON.stringify(transcripts)}`);
  }
});
