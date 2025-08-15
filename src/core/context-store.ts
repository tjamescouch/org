// src/core/context-store.ts
//
// A very simple context store that maintains a rolling window of chat
// history.  It can be used by agents or UI components to inspect recent
// messages without holding onto the entire conversation.  Messages are
// truncated when the store exceeds the configured maximum.

import type { ChatMessage } from "../types";

export class ContextStore {
  private history: ChatMessage[] = [];
  private max: number;

  constructor(maxMessages: number = 100) {
    this.max = Math.max(1, maxMessages);
  }

  /**
   * Append a message to the context.  If the history grows beyond the
   * configured limit, the oldest message is dropped.
   */
  push(msg: ChatMessage): void {
    this.history.push(msg);
    if (this.history.length > this.max) {
      this.history.shift();
    }
  }

  /**
   * Return the most recent N messages from the context.  If N is omitted
   * or exceeds the number of stored messages, all available messages are
   * returned.
   */
  getRecent(n: number = this.max): ChatMessage[] {
    if (n <= 0) return [];
    return this.history.slice(-n);
  }

  /**
   * Remove all stored messages from the context.
   */
  clear(): void {
    this.history = [];
  }
}

export default ContextStore;
