import { strict as assert } from "node:assert";
import {
  installSafeExecHook,
  __resetSafeExecHookForTests,
} from "../src/core/hooks/safe-exec-hook";

beforeEach(() => {
  process.env.SAFE_MODE = "1";
  __resetSafeExecHookForTests();
});

test("Bun.$ is gated in SAFE mode (denied -> not executed)", async () => {
  let asked = "";
  let called = false;

  // Fake Bun.$ we can observe
  const FakeBun: any = {
    $: (tpl: TemplateStringsArray, ..._vals: unknown[]) => {
      called = true;
      // emulate Bun.$ (won't be called in denied case)
      const p: any = Promise.resolve(0);
      p.exitCode = 0;
      p.text = async () => "should-not";
      return p;
    },
  };

  installSafeExecHook({
    bun: FakeBun,
    ask: async (q) => {
      asked = q;
      return false; // deny
    },
  });

  const res: any = await FakeBun.$`echo hello`;
  // original never called
  assert.equal(called, false, "original Bun.$ should not have been called when denied");
  // we show the preview question
  assert.match(asked, /About to run: echo hello/);
  // denied result still exposes an object with exitCode/text()
  assert.equal(typeof res.exitCode, "number");
  assert.equal(await res.text(), "");
});

test("Bun.$ allowed -> delegates to original", async () => {
  let asked = "";
  let called = false;

  const FakeBun: any = {
    $: (tpl: TemplateStringsArray, ..._vals: unknown[]) => {
      called = true;
      const p: any = Promise.resolve(0);
      p.exitCode = 0;
      p.text = async () => "ok";
      return p;
    },
  };

  installSafeExecHook({
    bun: FakeBun,
    ask: async (q) => {
      asked = q;
      return true; // allow
    },
  });

  const res: any = await FakeBun.$`printf ok`;
  assert.equal(called, true, "original Bun.$ should be called when allowed");
  assert.match(asked, /About to run: printf ok/);
  assert.equal(await res.text(), "ok");
});
