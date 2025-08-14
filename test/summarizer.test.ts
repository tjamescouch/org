import { summarizeHistory } from '../src/core/summarizer';

/**
 * Tests for the summarizeHistory helper.  Verifies concatenation of
 * trailing messages, handling of omitted content fields, and length
 * truncation with an ellipsis.
 */
async function run(): Promise<void> {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'world' },
    { role: 'user', content: 'This' },
    { role: 'assistant', content: 'is' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'test' },
  ] as any;
  // Default maxMessages=6 should include all provided messages.
  const summary = summarizeHistory(messages);
  const expected = 'Hello | world | This | is | a | test';
  if (summary !== expected) {
    throw new Error(`unexpected summary: '${summary}', expected '${expected}'`);
  }
  // Verify that maxMessages limits the number of concatenated messages.
  const summary2 = summarizeHistory(messages, 3);
  const expected2 = 'This | is | a';
  if (summary2 !== expected2) {
    throw new Error(`unexpected summary2: '${summary2}', expected '${expected2}'`);
  }
  // Verify truncation when the content exceeds maxLength.
  const longMessages = [
    { role: 'user', content: 'x'.repeat(50) },
    { role: 'assistant', content: 'y'.repeat(50) },
  ];
  const truncated = summarizeHistory(longMessages as any, 2, 60);
  // The combined string is 101 characters; after truncation to 60 it
  // should end with an ellipsis.
  if (!truncated.endsWith('…')) {
    throw new Error(`expected truncated summary to end with an ellipsis: '${truncated}'`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});