import { describe, test, expect } from "bun:test";
import { TtyScopes, type TtyIn } from "../../input/tty-scopes";
import { askUserLine, type RlFactory, type RlLike } from "../../input/user-prompt";

class FakeTty implements TtyIn {
  isTTY = true;
  isRaw?: boolean = false;
  setRawMode(mode: boolean) { this.isRaw = mode; }
}

class StubRl implements RlLike {
  prompts: string[] = [];
  constructor(private readonly answer: string) {}
  async question(q: string): Promise<string> { this.prompts.push(q); return this.answer; }
  close(): void { /* no-op */ }
}

describe("askUserLine", () => {
  test("prints one 'user: ' prompt and restores raw mode", async () => {
    const tty = new FakeTty();
    const scopes = new TtyScopes(tty);
    scopes.setMode("raw"); // simulate outer raw context

    const stub = new StubRl("ok");
    const rlFactory: RlFactory = () => stub;

    const result = await askUserLine({ rlFactory, scopes });
    expect(result).toBe("ok");

    // It should have shown exactly one prompt with 'user: '
    expect(stub.prompts).toEqual(["user: "]);

    // Outer mode restored
    expect(tty.isRaw).toBe(true);
  });

  test("custom username", async () => {
    const tty = new FakeTty();
    const scopes = new TtyScopes(tty);
    const stub = new StubRl("yo");
    const rlFactory: RlFactory = () => stub;

    const result = await askUserLine({ rlFactory, scopes, username: "alice" });
    expect(result).toBe("yo");
    expect(stub.prompts).toEqual(["alice: "]);
  });
});
