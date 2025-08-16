import { describe, test, expect } from "bun:test";
import { ContextStore } from "../src/core/context-store";

/**
 * Verify the ContextStore maintains a fixed‑size history and correctly
 * returns the most recent messages.  Also ensure that clearing the
 * history empties the store.
 */
describe("ContextStore", () => {
  test('context store retains and clears messages', () => {
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
  });

  test("push enforces max size and getRecent returns last N", () => {
    const store = new ContextStore(3);
    store.push({ role: "user", content: "a" } as any);
    store.push({ role: "user", content: "b" } as any);
    store.push({ role: "user", content: "c" } as any);
    store.push({ role: "user", content: "d" } as any);

    const recent = store.getRecent();
    expect(recent.map((m) => m.content)).toEqual(["b", "c", "d"]);

    expect(store.getRecent(2).map((m) => m.content)).toEqual(["c", "d"]);
  });

  test("clear empties the store", () => {
    const store = new ContextStore(2);
    store.push({ role: "user", content: "x" } as any);
    store.push({ role: "user", content: "y" } as any);
    store.clear();
    expect(store.getRecent().length).toBe(0);
  });
});
