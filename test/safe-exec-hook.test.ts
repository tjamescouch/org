import { strict as assert } from "node:assert";
import { installSafeExecHook } from "../src/core/hooks/safe-exec-hook";

test("Bun.$ is gated in SAFE mode (denied -> not executed)", async () => {
  let asked = "";
  let called = false;

  // Fake Bun.$ implementation we can observe
  const FakeBun: any = {
    $: (tpl: TemplateStringsArray, ...vals: unknown[]) => {
      called = true;
      // emulate Bun.$ promise that resolves to exit code
      const p: any = Promise.resolve(0);
      p.exitCode = 0;
      p.text = async () => "";
      return p;
    }
  };

  process.env.SAFE_MODE = "1";

  installSafeExecHook({
    bun: FakeBun,
    ask: async (q) => { asked = q; return false; }, // deny
  });

  const res: any = await FakeBun.$`echo hello`;
  assert.equal(called, false, "original Bun.$ should not have been called when denied");
  assert.match(asked, /About to run: echo hello/);
  assert.equal(typeof res.exitCode, "number");
  assert.equal(await res.text(), "");
});

test("Bun.$ allowed -> delegates to original", async () => {
  let asked = "";
  let called = false;
  const FakeBun: any = {
    $: (tpl: TemplateStringsArray, ...vals: unknown[]) => {
      called = true;
      const p: any = Promise.resolve(0);
      p.exitCode = 0;
      p.text = async () => "ok";
      return p;
    }
  };

  process.env.SAFE_MODE = "1";

  installSafeExecHook({
    bun: FakeBun,
    ask: async (q) => { asked = q; return true; }, // allow
  });

  const res: any = await FakeBun.$`printf ok`;
  assert.equal(called, true, "original Bun.$ should be called when allowed");
  assert.match(asked, /About to run: printf ok/);
  assert.equal(await res.text(), "ok");
});
