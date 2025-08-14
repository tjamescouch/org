// src/core/message-bus.ts
//
// A lightweight message bus used for decoupled event delivery inside the
// application.  Consumers can register listeners and emit messages
// asynchronously without a dependency on ChatRoom.  This bus does not
// guarantee ordering or delivery semantics beyond immediate invocation of
// listeners on emit().

import type { ChatMessage } from "../types";

export type MessageListener = (msg: ChatMessage) => void;

export class MessageBus {
  private listeners = new Set<MessageListener>();

  /**
   * Register a listener function to be invoked whenever a message is
   * emitted.  The same listener will not be registered twice.
   */
  public on(listener: MessageListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a previously registered listener.  If the listener was not
   * registered, this call has no effect.
   */
  public off(listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit a message to all registered listeners.  Each listener is
   * invoked synchronously with the provided message.  Errors in
   * listeners are swallowed to prevent one faulty handler from
   * disrupting others.
   */
  public emit(msg: ChatMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // ignore errors from individual listeners
      }
    }
  }
}
