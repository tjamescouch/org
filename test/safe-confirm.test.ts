import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import { confirm, shouldUseSafeMode } from "../src/core/utils/safe-confirm";

function withEnv<T>(patch: Record<string,string|undefined>, fn: () => T): T {
  const old: Record<string,string|undefined> = {};
  for (const k of Object.keys(patch)) { old[k] = process.env[k]; }
  try {
    for (const [k,v] of Object.entries(patch)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = String(v);
    }
    return fn();
  } finally {
    for (const [k,v] of Object.entries(old)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = String(v);
    }
  }
}

test("shouldUseSafeMode() respects env/argv", () => {
  withEnv({ SAFE_MODE: undefined }, () => {
    assert.equal(shouldUseSafeMode(["node","x"]), false);
    assert.equal(shouldUseSafeMode(["node","x","--safe"]), true);
  });
  withEnv({ SAFE_MODE: "1" }, () => {
    assert.equal(shouldUseSafeMode(["node","x"]), true);
  });
});

test("confirm() returns true immediately when not in safe-mode", async () => {
  const res = withEnv({ SAFE_MODE: undefined }, () => confirm("noop"));
  assert.equal(await res, true);
});

test("confirm() returns false in safe-mode when not TTY", async () => {
  const inp = new PassThrough() as any;
  inp.isTTY = false; // simulate non-interactive pipe
  const out = new PassThrough() as any;

  const res = await withEnv({ SAFE_MODE: "1" }, () =>
    confirm("danger", { input: inp, output: out })
  );
  assert.equal(res, false);
});

test("confirm() returns true when user presses 'y' in safe-mode", async () => {
  const inp = new PassThrough() as any;
  const out = new PassThrough() as any;
  inp.isTTY = true;
  inp.setRawMode = () => {}; // stub for bun/node compat

  const p = withEnv({ SAFE_MODE: "1" }, () =>
    confirm("run?", { input: inp, output: out })
  );

  // Simulate user typing 'y'
  setTimeout(() => { inp.write("y"); }, 5);

  assert.equal(await p, true);
});

test("confirm() returns default when user just hits Enter", async () => {
  const inp = new PassThrough() as any;
  const out = new PassThrough() as any;
  inp.isTTY = true;
  inp.setRawMode = () => {};

  const yes = withEnv({ SAFE_MODE: "1" }, () => confirm("q?", { input: inp, output: out, defaultYes: true }));
  setTimeout(() => { inp.write("\r"); }, 5);
  assert.equal(await yes, true);

  const no = withEnv({ SAFE_MODE: "1" }, () => confirm("q?", { input: inp, output: out, defaultYes: false }));
  setTimeout(() => { inp.write("\r"); }, 5);
  assert.equal(await no, false);
});
