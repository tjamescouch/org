import { ContextStore } from '../src/core/context-store';

/**
 * Verify the ContextStore maintains a fixed‑size history and correctly
 * returns the most recent messages.  Also ensure that clearing the
 * history empties the store.
 */
async function run(): Promise<void> {
  // Create a store that only keeps two messages.
  const store = new ContextStore(2);
  // Push three messages into the store.  The oldest should be evicted.
  store.push({ role: 'user', content: 'msg1' });
  store.push({ role: 'assistant', content: 'msg2' });
  store.push({ role: 'user', content: 'msg3' });
  // The store should only retain the last two messages (msg2 and msg3).
  const recent = store.getRecent();
  if (recent.length !== 2) {
    throw new Error(`expected 2 recent messages, got ${recent.length}`);
  }
  if (recent[0].content !== 'msg2' || recent[1].content !== 'msg3') {
    throw new Error(`unexpected recent messages: ${recent.map(m => m.content).join(',')}`);
  }
  // getRecent with explicit count should respect the requested limit.
  const one = store.getRecent(1);
  if (one.length !== 1 || one[0].content !== 'msg3') {
    throw new Error(`expected only the last message 'msg3', got ${one.map(m => m.content).join(',')}`);
  }
  // Clearing the store should remove all messages.
  store.clear();
  if (store.getRecent().length !== 0) {
    throw new Error('expected store to be empty after clear()');
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});