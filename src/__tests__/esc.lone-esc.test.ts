// bun test
import { expect, test } from "bun:test";
import { InputController } from "../input/controller";

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

test("lone ESC emits 'escape'", async () => {
  const ic = new InputController({ exitOnEsc: true, loneEscDelayMs: 20 });
  let escaped = false;
  let data = Buffer.alloc(0);
  ic.on("escape", () => { escaped = true; });
  ic.on("data", (b: Buffer) => { data = Buffer.concat([data, b]); });

  ic.feed(Buffer.from([0x1b])); // ESC
  await wait(30);

  expect(escaped).toBe(true);
  expect(data.length).toBe(0);
});

test("CSI sequence forwards as data (ESC + '[')", async () => {
  const ic = new InputController({ exitOnEsc: true, loneEscDelayMs: 20 });
  let escaped = false;
  let data = Buffer.alloc(0);
  ic.on("escape", () => { escaped = true; });
  ic.on("data", (b: Buffer) => { data = Buffer.concat([data, b]); });

  ic.feed(Buffer.from([0x1b]));          // ESC
  ic.feed(Buffer.from("["));             // next byte arrives quickly
  await wait(5);

  expect(escaped).toBe(false);
  expect(data.toString()).toBe("\x1b[");
});

test("passthrough disables ESC handling", async () => {
  const ic = new InputController({ exitOnEsc: true, loneEscDelayMs: 20 });
  let escaped = false;
  let data = Buffer.alloc(0);
  ic.on("escape", () => { escaped = true; });
  ic.on("data", (b: Buffer) => { data = Buffer.concat([data, b]); });

  ic.setPassthrough(true);
  ic.feed(Buffer.from([0x1b])); // ESC
  await wait(30);

  expect(escaped).toBe(false);
  expect(data.toString()).toBe("\x1b");
});
