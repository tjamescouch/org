import { ChatRoom } from '../src/core/chat-room';
import { Model } from '../src/core/entity/model';
import { test } from 'bun:test';

// A model that records received messages for inspection.
class RecordingModel extends Model {
  public messages: any[] = [];
  constructor(id: string) { super(id); }
  async receiveMessage(msg: any): Promise<void> {
    this.messages.push(msg);
  }
}

/**
 * Extended tests for ChatRoom.  Verifies directed send behaviour,
 * broadcast delivery, and freshness tracking when messages originate
 * from the end user versus other agents.
 */
test('chat-room fresh user message tracking and delivery', async () => {
  const room = new ChatRoom();
  const alice = new RecordingModel('alice');
  room.addModel(alice as any);
  // Sending a message from a non‑user should not update the freshness flag.
  await room.sendTo('assistant', 'alice', 'hello');
  if (room.hasFreshUserMessage()) {
    throw new Error('freshness flag should remain false after agent sendTo');
  }
  // Verify that the message was delivered with the correct "to" field.
  if (alice.messages.length !== 1 || alice.messages[0].to !== 'alice') {
    throw new Error('sendTo did not deliver the correct to/recipient');
  }
  // Sending a message from the end user should update freshness.
  await room.sendTo('User', 'alice', 'user hello');
  if (!room.hasFreshUserMessage()) {
    throw new Error('freshness flag should be true immediately after user sendTo');
  }
  // Broadcast a user message; this should also update freshness and
  // deliver to all models.
  await room.broadcast('User', 'broadcast msg');
  if (!room.hasFreshUserMessage()) {
    throw new Error('freshness flag should be true after user broadcast');
  }
  if (alice.messages.length !== 3) {
    throw new Error(`expected 3 delivered messages, got ${alice.messages.length}`);
  }
  // Wait for the freshness window to expire.
  await new Promise(res => setTimeout(res, 2100));
  if (room.hasFreshUserMessage()) {
    throw new Error('freshness flag should be false after the window expires');
  }
});