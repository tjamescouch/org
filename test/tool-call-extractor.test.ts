import { extractToolCallsFromText } from '../src/tools/tools/tool-call-extractor';

/**
 * Test that the tool-call extractor correctly parses the tool_calls array from
 * assistant output and strips it from the cleaned text.  Ensures that the
 * normalized result exposes the tool call structure and leaves other content
 * intact.
 */
// Convert this file into a Bun test.  Bun’s test runner looks for calls to
// test() and does not execute top-level async functions.  We wrap the
// previous logic in a test case to ensure it runs under bun test.
import { test } from 'bun:test';

test('extract tool-calls and cleaned output', () => {
  const input = '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"sh","arguments":"{\\"cmd\\":\\"echo hi\\"}"}}]} Hello world!';
  const { tool_calls, cleaned } = extractToolCallsFromText(input);
  if (tool_calls.length !== 1) {
    throw new Error(`expected one tool call, got ${tool_calls.length}`);
  }
  const call = tool_calls[0] as any;
  if (call.name !== 'sh' || !call.function || call.function.name !== 'sh') {
    throw new Error(`expected tool name 'sh', got ${call.name}/${call.function?.name}`);
  }
  if (cleaned.trim() !== 'Hello world!') {
    throw new Error(`unexpected cleaned text: '${cleaned}'`);
  }
});