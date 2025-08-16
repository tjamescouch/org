import { test } from 'bun:test';
import { ChatRoom } from '../src/core/chat-room';
import { Model } from '../src/core/entity/model';

// A minimal model stub used to register with the ChatRoom. It does nothing
// with incoming messages.
class Dummy extends Model {
  constructor(id: string) { super(id); }
  async receiveMessage(_msg: any): Promise<void> {
    /* no-op */
  }
}

describe("ChatRoom", () => {
  /**
   * Basic test to verify that ChatRoom.hasFreshUserMessage returns true
   * immediately after a user message and false after the freshness window
   * expires.  The test uses a simple timeout to simulate the passage of time.
   */
  test('basic fresh user message tracking', async () => {
    const room = new ChatRoom();
    const dummy = new Dummy('dummy');
    // Add the dummy model to the room so that messages can be delivered
    room.addModel(dummy as any);
    // Broadcast a user message and assert that the freshness flag is true
    await room.broadcast('User', 'Hello');
    if (!room.hasFreshUserMessage()) {
      throw new Error('hasFreshUserMessage() should return true immediately after a user message');
    }
    // Wait long enough for the freshness window to expire (slightly over 2s)
    await new Promise(res => setTimeout(res, 2200));
    if (room.hasFreshUserMessage()) {
      throw new Error('hasFreshUserMessage() should return false after the freshness window expires');
    }
  });

  test("broadcast from User updates freshness window", async () => {
    const room = new ChatRoom();
    const inbox: any[] = [];
    room.addModel(makeModel("a", inbox));
    room.addModel(makeModel("b", inbox));

    expect(room.hasFreshUserMessage()).toBe(false);
    await room.broadcast("User", "hello");
    expect(room.hasFreshUserMessage()).toBe(true);
    expect(inbox.length).toBe(2);
  });

  test("broadcast from agent does not update user freshness", async () => {
    const room = new ChatRoom();
    const inbox: any[] = [];
    room.addModel(makeModel("a", inbox));
    await room.broadcast("alice", "hey");
    expect(room.hasFreshUserMessage()).toBe(false);
  });

  test("sendTo targets a specific recipient", async () => {
    const room = new ChatRoom();
    const inbox: any[] = [];
    room.addModel(makeModel("a", inbox));
    room.addModel(makeModel("b", inbox));

    await room.sendTo("User", "b", "hi b");
    expect(inbox.length).toBe(1);
    expect(inbox[0].id).toBe("b");
  });
});
