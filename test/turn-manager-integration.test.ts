import { test } from 'bun:test';
import { ChatRoom } from '../src/core/chat-room';
import { TurnManager } from '../src/core/turn-manager';
import { Model } from '../src/core/entity/model';

class EchoAgent extends Model {
  public inbox: any[] = [];
  private responses: string[];
  private responded: number = 0;
  constructor(id: string, responses: string[]) { super(id); this.responses = responses; }
  async receiveMessage(msg: any) {
    // Do not queue messages sent from self
    if (msg.from === this.id) return;
    this.inbox.push(msg);
  }
  hasUnread(): boolean { return this.inbox.length > 0; }
  async takeTurn(): Promise<boolean> {
    if (!this.inbox.length) return false;
    this.inbox.shift();
    const resp = this.responses[this.responded++];
    if (resp) {
      // Respond to the group
      await this.broadcast(resp);
    }
    return true;
  }
}

test('turn manager schedules agents with custom model', async () => {
  const room = new ChatRoom();
  const alice = new EchoAgent('Alice', ['Hi Bob']);
  const bob   = new EchoAgent('Bob',   ['Hello Alice']);
  room.addModel(alice as any);
  room.addModel(bob as any);

  // Kick off conversation with a user broadcast
  await room.broadcast('User', 'start');

  const tm = new TurnManager(room, [alice as any, bob as any], { tickMs: 100, idleBackoffMs: 50, proactiveMs: 200 });
  tm.start();
  // Allow some time for agents to respond
  await new Promise(resolve => setTimeout(resolve, 1000));
  tm.stop();

  if (alice['responded'] < 1 || bob['responded'] < 1) {
    throw new Error(`Agents did not both respond: alice=${alice['responded']} bob=${bob['responded']}`);
  }
});