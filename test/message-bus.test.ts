import { MessageBus } from '../src/core/message-bus';
import { test } from 'bun:test';

/**
 * Ensure that MessageBus correctly registers listeners, delivers
 * messages to all listeners, swallows listener errors, and honours
 * deregistration via off().
 */
test('message bus registers, emits and deregisters listeners', async () => {
  const bus = new MessageBus();
  let count1 = 0;
  let count2 = 0;
  const listener1 = (msg: any) => {
    count1++;
    // Throw on a specific payload to verify error isolation.
    if (msg.content === 'throw') {
      throw new Error('listener error');
    }
  };
  const listener2 = (_msg: any) => {
    count2++;
  };
  // Register both listeners.
  bus.on(listener1);
  bus.on(listener2);
  // Emit a normal message; both listeners should be invoked.
  bus.emit({ role: 'user', content: 'first' } as any);
  if (count1 !== 1 || count2 !== 1) {
    throw new Error(`listeners not invoked correctly: count1=${count1}, count2=${count2}`);
  }
  // Emit a message that triggers an exception in listener1.  Both
  // listeners should still be called once more, and the error should
  // not propagate to the bus.
  bus.emit({ role: 'assistant', content: 'throw' } as any);
  if (count1 !== 2 || count2 !== 2) {
    throw new Error(`listeners did not handle error case: count1=${count1}, count2=${count2}`);
  }
  // Remove listener1 and emit again.  Only listener2 should be invoked.
  bus.off(listener1);
  bus.emit({ role: 'assistant', content: 'third' } as any);
  if (count1 !== 2) {
    throw new Error(`listener1 should not be called after off(): count1=${count1}`);
  }
  if (count2 !== 3) {
    throw new Error(`listener2 should have been called three times: count2=${count2}`);
  }
});