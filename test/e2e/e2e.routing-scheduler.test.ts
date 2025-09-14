/* test/e2e.routing-scheduler.test.ts
 * Focus: routing + scheduling interplay using a deterministic harness.
 */

import { describe, it, expect } from "bun:test";
import { SchedulingHarness, ScriptedResponder, sequence } from "../helpers/scheduling-harness";

describe("routing + scheduling", () => {
  it("user -> agent -> user", async () => {
    const alice = new ScriptedResponder("alice", sequence(["@@user hi from alice"]));
    const h = new SchedulingHarness([alice]);

    await h.userSends("@@alice hello");
    await h.runUntilUser();

    expect(h.flow()).toBe("user -> alice -> user");
  });

  it("user -> agent1 -> agent2 -> user", async () => {
    const alice = new ScriptedResponder("alice", sequence(["@@bob ping"]));
    const bob   = new ScriptedResponder("bob",   sequence(["@@user pong"]));
    const h = new SchedulingHarness([alice, bob]);

    await h.userSends("@@alice start");
    await h.runUntilUser();

    expect(h.flow()).toBe("user -> alice -> bob -> user");
  });

  it("user -> @@agent -> @@user", async () => {
    const bob   = new ScriptedResponder("bob", sequence(["@@user ack"]));
    const h = new SchedulingHarness([bob]);

    await h.userSends("@@bob hello");
    await h.runUntilUser();

    expect(h.flow()).toBe("user -> bob -> user");
  });

  it("user -> @@group. -> ... (fan-out then one replies)", async () => {
    const alice = new ScriptedResponder("alice", sequence([]));                  // stays quiet
    const bob   = new ScriptedResponder("bob",   sequence(["@@user group-ack"])); // replies to user
    const carol = new ScriptedResponder("carol", sequence([]));                  // stays quiet
    const h = new SchedulingHarness([alice, bob, carol]);

    await h.userSends("@@group. hello everyone!"); // note the trailing dot
    await h.runUntilUser();

    expect(h.flow()).toBe("user -> bob -> user");
  });
});
