/*
 * Comprehensive test suite for the multi‑agent terminal chat application.
 *
 * These tests are written in TypeScript and designed to run under Bun's
 * built‑in test runner (`bun test`).  They exercise the core utilities
 * (tag parsing and routing), the execution gating logic, the shell
 * execution helper, and the high‑level LlmAgent integration with a custom
 * ChatDriver.  Simple stubs are provided to simulate asynchronous
 * interactions without any external dependencies.
 */

import { test } from 'bun:test';
import assert from 'assert';

import { TagParser } from '../src/utils/tag-parser';
import { routeWithTags, makeRouter } from '../src/routing/route-with-tags';
import { ExecutionGate } from '../src/tools/execution-gate';
import { NoDangerousRm, NoRm, NoGitPush } from '../src/tools/execution-guards';
import { runSh } from '../src/tools/sh';
import { LlmAgent } from '../src/agents/llm-agent';
import type { ChatDriver, ChatOutput, ChatToolCall } from '../src/drivers/types';

// -----------------------------------------------------------------------------
// Helper definitions

/**
 * Helper: a stub ChatDriver that returns predetermined outputs in sequence.
 * Each call to chat() yields the next ChatOutput from the provided array.
 */
class StubDriver implements ChatDriver {
  private outputs: ChatOutput[];
  private idx = 0;
  constructor(outputs: ChatOutput[]) {
    this.outputs = outputs;
  }
  async chat(): Promise<ChatOutput> {
    const out = this.outputs[this.idx] || { text: '', toolCalls: [] };
    this.idx++;
    return out;
  }
}

/**
 * Simple utility to build a ChatToolCall.  The LlmAgent expects
 * ChatToolCall objects with id, type and function properties, where
 * function.arguments is a JSON string.  This helper reduces boilerplate.
 */
function makeToolCall(id: string, name: string, args: any): ChatToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Reset the execution gate to a known state between test cases.  The
 * ExecutionGate maintains static settings and guard instances.  Calling
 * configure() with explicit options ensures consistent behaviour.  Note
 * that passing an empty guards array would disable safety checks, so we
 * re‑instantiate the default guards here.  Safe mode is disabled by
 * default to avoid interactive prompts.
 */
function resetExecutionGate(): void {
  const guards = [new NoDangerousRm(), new NoRm(), new NoGitPush()];
  ExecutionGate.configure({ safe: false, interactive: true, guards });
}

// Ensure the gate is in a known default state before any tests run.
resetExecutionGate();

// -----------------------------------------------------------------------------
// TagParser Tests

test('TagParser parses untagged text as a single group message', () => {
  const parts = TagParser.parse('hello world');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'group');
  assert.equal(parts[0].content, 'hello world');
});

test('TagParser splits preamble and an agent tag', () => {
  const parts = TagParser.parse('preamble @@bob hi there');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, 'group');
  assert.equal(parts[0].content, 'preamble');
  assert.equal(parts[1].kind, 'agent');
  assert.equal((parts[1] as any).tag.toLowerCase(), 'bob');
  assert.equal(parts[1].content, 'hi there');
});

test('TagParser handles explicit file names with colon notation', () => {
  const parts = TagParser.parse('##file:notes.txt This is the notes');
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.equal(p.kind, 'file');
  // File tags are normalised to a relative path if not starting with /. or ./
  assert.equal((p as any).tag, './notes.txt');
  assert.equal(p.content, 'This is the notes');
});

test('TagParser handles shorthand file names without explicit "file:" prefix', () => {
  const parts = TagParser.parse('##report.md Contents of report');
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.equal(p.kind, 'file');
  assert.equal((p as any).tag, './report.md');
  assert.equal(p.content, 'Contents of report');
});

test('TagParser supports file names with slashes', () => {
  const parts = TagParser.parse('##src/main.ts export const x = 1;');
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.equal(p.kind, 'file');
  assert.equal((p as any).tag, './src/main.ts');
  assert.equal(p.content, 'export const x = 1;');
});

test('TagParser parses multiple tags in order', () => {
  const input = 'Hello @@user please review @@group everyone ##summary.txt Data';
  const parts = TagParser.parse(input);
  // Should produce group preamble, user tag, group tag and file tag
  assert.equal(parts.length, 4);
  // Group preamble
  assert.equal(parts[0].kind, 'group');
  assert.equal(parts[0].content, 'Hello');
  // User message
  assert.equal(parts[1].kind, 'user');
  assert.equal(parts[1].content, 'please review');
  // Group message
  assert.equal(parts[2].kind, 'group');
  assert.equal(parts[2].content, 'everyone');
  // File
  assert.equal(parts[3].kind, 'file');
  assert.equal((parts[3] as any).tag, './summary.txt');
  assert.equal(parts[3].content, 'Data');
});

// -----------------------------------------------------------------------------
// routeWithTags Tests

test('routeWithTags treats untagged text as a group message', () => {
  const outcome = routeWithTags('hello');
  assert.equal(outcome.deliveries.length, 1);
  assert.equal(outcome.deliveries[0].kind, 'group');
  assert.equal(outcome.deliveries[0].content, 'hello');
  assert.equal(outcome.yieldForGroup, true);
  assert.equal(outcome.yieldForUser, false);
});

test('routeWithTags handles agent targeted messages', () => {
  const outcome = routeWithTags('@@alice Hi Alice');
  assert.equal(outcome.deliveries.length, 1);
  const d = outcome.deliveries[0];
  assert.equal(d.kind, 'agent');
  assert.equal((d as any).to, 'alice');
  assert.equal(d.content, 'Hi Alice');
  assert.equal(outcome.yieldForGroup, false);
  assert.equal(outcome.yieldForUser, false);
});

test('routeWithTags handles group directed messages', () => {
  const outcome = routeWithTags('@@group Team update');
  assert.equal(outcome.deliveries.length, 1);
  const d = outcome.deliveries[0];
  assert.equal(d.kind, 'group');
  assert.equal(d.content, 'Team update');
  assert.equal(outcome.yieldForGroup, true);
});

test('routeWithTags handles user directed messages', () => {
  const outcome = routeWithTags('@@user Need input');
  assert.equal(outcome.deliveries.length, 1);
  const d = outcome.deliveries[0];
  assert.equal(d.kind, 'user');
  assert.equal(d.content, 'Need input');
  assert.equal(outcome.yieldForUser, true);
});

test('routeWithTags handles mixed tags and sets flags appropriately', () => {
  const input = '@@bob Hi Bob @@group All @@user Ping';
  const outcome = routeWithTags(input);
  assert.equal(outcome.deliveries.length, 3);
  // agent
  const d0 = outcome.deliveries[0];
  assert.equal(d0.kind, 'agent');
  assert.equal((d0 as any).to, 'bob');
  // group
  const d1 = outcome.deliveries[1];
  assert.equal(d1.kind, 'group');
  // user
  const d2 = outcome.deliveries[2];
  assert.equal(d2.kind, 'user');
  assert.equal(outcome.yieldForGroup, true);
  assert.equal(outcome.yieldForUser, true);
});

// -----------------------------------------------------------------------------
// makeRouter Tests

test('makeRouter dispatches calls to provided callbacks', async () => {
  const calls: Array<{ kind: string; from: string; to?: string; name?: string; content: string }> = [];
  const router = makeRouter({
    onAgent: (from, to, content) => {
      calls.push({ kind: 'agent', from, to, content });
    },
    onGroup: (from, content) => {
      calls.push({ kind: 'group', from, content });
    },
    onUser: (from, content) => {
      calls.push({ kind: 'user', from, content });
    },
    onFile: (from, name, content) => {
      calls.push({ kind: 'file', from, name, content });
    },
  });
  const msg = 'Intro @@dave Hi @@group Everyone ##doc.txt Contents @@user Please review';
  const outcome = await router('alice', msg);
  // Four deliveries: preamble group, agent, group, file, user
  assert.equal(calls.length, 5);
  // Group preamble
  assert.deepEqual(calls[0], { kind: 'group', from: 'alice', content: 'Intro' });
  // Agent to dave
  assert.deepEqual(calls[1], { kind: 'agent', from: 'alice', to: 'dave', content: 'Hi' });
  // Group broadcast
  assert.deepEqual(calls[2], { kind: 'group', from: 'alice', content: 'Everyone' });
  // File delivery
  assert.deepEqual(calls[3], { kind: 'file', from: 'alice', name: './doc.txt', content: 'Contents' });
  // User delivery
  assert.deepEqual(calls[4], { kind: 'user', from: 'alice', content: 'Please review' });
  // Outcome flags should mark both group and user present
  assert.equal(outcome.yieldForGroup, true);
  assert.equal(outcome.yieldForUser, true);
});

// -----------------------------------------------------------------------------
// ExecutionGate and runSh Tests

test('ExecutionGate.configure rejects unsafe non‑interactive combinations', () => {
  // Safe + non‑interactive should throw
  assert.throws(() => {
    ExecutionGate.configure({ safe: true, interactive: false, guards: [] });
  });
  // Safe + interactive is allowed
  assert.doesNotThrow(() => {
    ExecutionGate.configure({ safe: true, interactive: true, guards: [] });
  });
  // Reset the gate for subsequent tests
  resetExecutionGate();
});

test('ExecutionGate.gate denies commands when a guard vetoes', async () => {
  // Install a guard that always denies
  ExecutionGate.configure({ safe: false, interactive: true, guards: [ { allow: () => false } as any ] });
  // Denied commands should throw
  await assert.rejects(() => ExecutionGate.gate('echo test'));
  // Restore defaults
  resetExecutionGate();
});

test('runSh executes harmless commands and captures output', async () => {
  // Use default guard configuration (no rm/git push) and safe mode disabled
  resetExecutionGate();
  const res = await runSh('echo hello');
  assert.equal(res.ok, true);
  // stdout may include a trailing newline
  assert.match(res.stdout, /hello/);
  assert.equal(res.exit_code, 0);
});

test('runSh rejects dangerous commands according to default guards', async () => {
  resetExecutionGate();
  // rm commands are blocked by the NoRm guard
  let res = await runSh('rm -rf tmpfile');
  assert.equal(res.ok, false);
  assert.equal(res.exit_code, 10101);
  assert.match(res.stderr, /Execution denied by guard or user/);
  // rm -rf / is also blocked by the NoDangerousRm guard
  res = await runSh('rm -rf /');
  assert.equal(res.ok, false);
  assert.equal(res.exit_code, 10101);
  // git push is blocked by NoGitPush guard
  res = await runSh('git push origin main');
  assert.equal(res.ok, false);
  assert.equal(res.exit_code, 10101);
});

// -----------------------------------------------------------------------------
// LlmAgent Tests

test('LlmAgent.respond returns assistant text when no tool calls are present', async () => {
  const driver = new StubDriver([
    { text: 'Hello there!', toolCalls: [] },
  ]);
  const agent = new LlmAgent('tester', driver, 'mock-model');
  const { message, toolsUsed } = await agent.respond('Hi', 2, ['tester']);
  assert.equal(message, 'Hello there!');
  assert.equal(toolsUsed, 0);
});

test('LlmAgent executes sh tool call and ends the turn when no assistant text is produced', async () => {
  // First model output is a tool call; after the tool runs, the system now ends the turn
  // (it does not immediately make another chat call to fetch assistant text).
  const driver = new StubDriver([
    { text: '', toolCalls: [ makeToolCall('1', 'sh', { cmd: 'echo hi' }) ] },
  ]);
  const agent = new LlmAgent('tester', driver, 'mock-model');
  const res = await agent.respond('Run command', 2, ['tester']);

  // No assistant text is returned; exactly one tool call was consumed.
  assert.equal(res.message, '');
  assert.equal(res.toolsUsed, 1);
});

test('LlmAgent handles unknown tool calls gracefully', async () => {
  // Unknown tool now ends the turn immediately (no assistant text), but still counts as a tool use.
  const driver = new StubDriver([
    { text: '', toolCalls: [ makeToolCall('1', 'unknownTool', {}) ] },
  ]);
  const agent = new LlmAgent('tester', driver, 'mock-model');
  const res = await agent.respond('Prompt', 2, ['tester']);
  // No assistant text is returned when the system ends the turn.
  assert.equal(res.message, '');
  // The unknown tool still counts against the tool budget.
  assert.equal(res.toolsUsed, 1);
});

test('LlmAgent handles malformed sh tool calls with missing cmd', async () => {
  // A sh call with no cmd is treated as an error and the system ends the turn (no assistant text).
  const driver = new StubDriver([
    { text: '', toolCalls: [ makeToolCall('1', 'sh', {}) ] },
  ]);
  const agent = new LlmAgent('tester', driver, 'mock-model');
  const res = await agent.respond('Bad cmd', 2, ['tester']);
  // No assistant text because the turn ends early.
  assert.equal(res.message, '');
  // Still counted as one tool usage.
  assert.equal(res.toolsUsed, 1);
});
