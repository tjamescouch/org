import { test } from 'bun:test';
import * as http from 'http';

// Set environment variables before loading any project code to ensure
// the mock base URL and model are used by chatOnce and AgentModel.
const port = 5000 + Math.floor(Math.random() * 4000);
process.env.OLLAMA_BASE_URL = `http://localhost:${port}`;
process.env.OLLAMA_MODEL = 'mock';

import { ChatRoom } from '../src/core/chat-room';
import { AgentModel } from '../src/core/entity/agent-model';
import { TurnManager } from '../src/core/turn-manager';
import { Logger } from '../src/logger';

// Relax global transport concurrency for this test.  AgentModel
// registers a single-flight transport gate on the global object; by
// increasing the cap we allow both agents to make concurrent network
// calls during the test.  Without this, the default cap=1 causes
// the second agent to wait for the first to finish, leading to
// timeouts when the scheduler doesn’t give it another turn before
// the test limit.
(globalThis as any).__transport = (globalThis as any).__transport || { cap: 1 };
(globalThis as any).__transport.cap = 2;

/**
 * End‑to‑end integration test that spins up a mock HTTP provider and
 * verifies that two agents (alice and bob) both respond to a user
 * message.  This uses the TurnManager scheduler to drive agent
 * turns and records agent outputs via a monkey‑patched ChatRoom
 * broadcast.
 */
test('multi-agent integration with mock server', async () => {
  // Create a simple mock HTTP server implementing the minimal API
  // required by chatOnce(): preflight endpoints and chat completions.
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
      // Drain the request body then respond with a canned reply after a
      // small delay to simulate processing time.
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        setTimeout(() => {
          const response = {
            choices: [ { message: { role: 'assistant', content: `ok` } } ],
          };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(response));
        }, 10);
      });
      return;
    }
    // Default: 404
    res.statusCode = 404;
    res.end('Not Found');
  });

  // Start the mock server
  await new Promise<void>(resolve => server.listen(port, resolve));

  try {
    const room = new ChatRoom();
    const alice = new AgentModel('alice', 'mock');
    const bob = new AgentModel('bob', 'mock');
    room.addModel(alice as any);
    room.addModel(bob as any);

    // Capture agent outputs by monkey‑patching ChatRoom.broadcast.
    const transcripts: { agent: string; content: string }[] = [];
    const originalBroadcast = room.broadcast.bind(room);
    room.broadcast = async (from: string, content: string, directTo?: string) => {
      if (from !== 'User') {
        transcripts.push({ agent: from, content: String(content) });
      }
      return originalBroadcast(from, content, directTo);
    };

    // Send an initial user message.
    await room.broadcast('User', 'Hello agents');

    // Kick off a TurnManager to drive the agents.
    const tm = new TurnManager(room, [alice, bob], {
      tickMs: 100,
      turnTimeoutMs: 2000,
      idleBackoffMs: 100,
      proactiveMs: 500,
    });
    tm.start();

    // Wait a short time to allow agents to respond.
    await new Promise(res => setTimeout(res, 2000));

    tm.stop();

    // We expect each agent to have responded at least once.
    const responders = new Set(transcripts.map(t => t.agent.toLowerCase()));
    // Emit a debug log of the transcript for diagnosis.  This is
    // particularly useful when running under a test harness to see
    // which agents replied and what their content was.
    Logger.debug('multi-agent transcript', transcripts);
    if (!responders.has('alice') || !responders.has('bob')) {
      throw new Error(`expected replies from both agents, got ${Array.from(responders).join(',')}`);
    }
  } finally {
    server.close();
  }
});