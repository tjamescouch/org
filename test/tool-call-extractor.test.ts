import { extractToolCallsFromText } from '../src/tools/tools/tool-call-extractor';

/**
 * Test that the tool-call extractor correctly parses the tool_calls array from
 * assistant output and strips it from the cleaned text.  Ensures that the
 * normalized result exposes the tool call structure and leaves other content
 * intact.
 */
async function run(): Promise<void> {
  const input = '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"sh","arguments":"{\\"cmd\\":\\"echo hi\\"}"}}]} Hello world!';
  const { tool_calls, cleaned } = extractToolCallsFromText(input);
  if (tool_calls.length !== 1) {
    throw new Error(`expected one tool call, got ${tool_calls.length}`);
  }
  const call = tool_calls[0];
  // Ensure both the top-level name and nested function.name are exposed
  if ((call as any).name !== 'sh' || !(call as any).function || (call as any).function.name !== 'sh') {
    throw new Error(`expected tool name 'sh', got ${(call as any).name}/${(call as any).function?.name}`);
  }
  // The cleaned output should retain the trailing message text and strip the JSON
  if (cleaned.trim() !== 'Hello world!') {
    throw new Error(`unexpected cleaned text: '${cleaned}'`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});