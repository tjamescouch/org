// test/input/tty-controller.test.ts
// Stable unit tests for TTY controller hotkeys + I/O.
// Key change vs. previous version: process.exit is stubbed to **record** exit,
// not throw. Tests assert `lastExitCode` instead of catching throws. This
// prevents the controller's "Finalize failed; exit(1)" recovery branch from
// being triggered by the test stub itself.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import { TtyController } from "../../src/input/tty-controller";

// ----------------------------- fakes / harness ------------------------------

class MockTTYIn extends Readable implements NodeJS.ReadStream {
  isTTY = true;
  isRaw = true;
  private _paused = false;

  constructor() { super({ read() {/* pull-mode not used */} }); }

  setRawMode(v: boolean) { this.isRaw = v; }
  get isRawMode(): boolean { return this.isRaw; }

  resume() { this._paused = false; return super.resume(); }
  pause()  { this._paused = true;  return super.pause();  }
  get paused(): boolean { return this._paused; }

  /** Feed bytes as if user typed them (raw data path). */
  emitData(chunk: Buffer | string) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.emit("data", buf);
  }

  /** Push text for readline(question) consumption. */
  pushString(s: string) { this.push(s); }
}

class MockTTYOut extends Writable implements NodeJS.WriteStream {
  isTTY = true;
  columns = 80;
  rows = 24;
  buffer = "";
  _write(chunk: any, _enc: any, cb: any) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    cb();
  }
}

class Capture extends Writable {
  data = "";
  _write(chunk: any, _enc: any, cb: any) {
    this.data += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    cb();
  }
}

class MockScheduler {
  enqueued: string[] = [];
  async enqueueUserText(t: string) { this.enqueued.push(t); }
}

// Utility: soft deadline wrapper
function withDeadline<T>(p: Promise<T>, ms: number, label = "deadline"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const delay = (ms = 0) => new Promise<void>(r => setTimeout(r, ms));

// -------------------- process.exit stub (record, don't throw) -----------------

let exitOrig: any;
let lastExitCode: number | null = null;

function stubExit() {
  lastExitCode = null;
  exitOrig = process.exit;
  (process as any).exit = (code?: number) => {
    lastExitCode = code ?? 0;
    // Do NOT throw. We assert on `lastExitCode` in tests.
    return undefined as any;
  };
}
function restoreExit() { (process as any).exit = exitOrig; }

// ----------------------------- shared per-test ------------------------------

let stdin: MockTTYIn;
let stdout: MockTTYOut;
let stderr: Capture;
let ctl: TtyController;
let scheduler: MockScheduler;
let finalizerCalls: number;

beforeEach(async () => {
  stdin = new MockTTYIn();
  stdout = new MockTTYOut();
  stderr = new Capture();
  scheduler = new MockScheduler();
  finalizerCalls = 0;

  ctl = new TtyController({
    stdin,
    stdout,
    prompt: "You > ",
    interjectKey: "i",
    interjectBanner: "You > ",
    feedbackStream: stderr,
    finalizer: async () => { finalizerCalls++; },
    loopMode: "external",
    forceExclusive: true,
  });
  ctl.setScheduler(scheduler as any);
  stubExit();
  await ctl.start();
});

afterEach(async () => {
  try { await ctl.unwind(); } catch { /* ignore */ }
  restoreExit();
});

// ------------------------------------ tests ---------------------------------

describe("ESC during streaming → defers finalize+review", () => {
  test("ACK immediately, finalize+exit(0) on stream end", async () => {
    ctl.onStreamStart();

    // Simulate ESC raw byte
    stdin.emitData(Buffer.from([0x1b]));
    await delay(10); // let ACK flush

    expect(stderr.data).toMatch(/ESC pressed.*finishing current step/i);
    expect(lastExitCode).toBe(null); // not yet

    // End the stream: controller should finalize and exit(0)
    await ctl.onStreamEnd();
    await delay(10);

    expect(lastExitCode).toBe(0);
    expect(finalizerCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("'i' during streaming → defer prompt", () => {
  test("ACK now; prompt after stream ends; enqueue user answer", async () => {
    ctl.onStreamStart();

    stdin.emitData("i");
    await delay(10);
    expect(stderr.data).toMatch(/waiting for model to finish/i);
    expect(scheduler.enqueued.length).toBe(0);

    // End stream → prompt opens; answer "hello"
    const ended = ctl.onStreamEnd();
    await delay(15);
    stdin.pushString("hello\n");
    await ended;

    expect(scheduler.enqueued).toEqual(["hello"]);
    expect(lastExitCode).toBe(null); // no exit on interject path
  });
});

describe("ESC when idle → finalize now", () => {
  test("finalize called and exit(0)", async () => {
    stdin.emitData(Buffer.from([0x1b])); // ESC when idle
    await delay(15);
    expect(lastExitCode).toBe(0);
    expect(finalizerCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("'i' when idle → prompt immediately", () => {
  test("user answer is enqueued", async () => {
    stdin.emitData("i");
    await delay(10);
    stdin.pushString("foo bar\n");
    await delay(15);
    expect(scheduler.enqueued).toEqual(["foo bar"]);
    expect(lastExitCode).toBe(null);
  });
});

describe("Ctrl+C → immediate exit(130)", () => {
  test("SIGINT status printed and exit code 130", async () => {
    stdin.emitData(Buffer.from([0x03])); // ETX
    await delay(10);
    expect(lastExitCode).toBe(130);
    expect(stderr.data).toMatch(/sigint/i);
  });
});

describe("Non-interactive mode disables hotkeys", () => {
  test("no exit, no ACK, no enqueue", async () => {
    // Recreate controller with isTTY=false
    await ctl.unwind();
    restoreExit();

    const niIn = new MockTTYIn();
    niIn.isTTY = false;

    const niErr = new Capture();
    finalizerCalls = 0;
    const niCtl = new TtyController({
      stdin: niIn,
      stdout,
      prompt: "You > ",
      interjectKey: "i",
      interjectBanner: "You > ",
      feedbackStream: niErr,
      finalizer: async () => { finalizerCalls++; },
      loopMode: "external",
    });
    niCtl.setScheduler(scheduler as any);

    stubExit();
    await niCtl.start();

    niIn.emit("data", Buffer.from([0x1b])); // ESC
    niIn.emit("data", Buffer.from("i"));    // 'i'
    await delay(20);

    expect(niErr.data).toBe("");               // no ACKs
    expect(scheduler.enqueued.length).toBe(0); // no interject
    expect(lastExitCode).toBe(null);           // no exit
    await niCtl.unwind();
  });
});

describe("Prompt RAW/COOKED and flow restoration", () => {
  test("prompt toggles to COOKED then back to RAW; ESC after prompt is handled", async () => {
    // Call a readUserLine; provide a quick answer, ensure RAW restored and bytes flow.
    const p = ctl.readUserLine("You > ");
    await delay(10); // allow prompt to open and toggle COOKED
    expect(stdin.isRawMode).toBe(false);

    // answer
    stdin.pushString("ok\n");
    await p;
    await delay(10);

    // RAW restored & flow resumed
    expect(stdin.isRawMode).toBe(true);

    // Now verify bytes flow: ESC should trigger finalize+exit
    stdin.emitData(Buffer.from([0x1b]));
    await delay(15);
    expect(lastExitCode).toBe(0);
    expect(finalizerCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("No stdout pollution from ACK", () => {
  test("ACK goes to feedback (stderr), not stdout", async () => {
    ctl.onStreamStart();
    stdin.emitData(Buffer.from([0x1b])); // ESC during stream
    await delay(10);
    expect(stderr.data).toContain("ESC pressed");
    expect(stdout.buffer).not.toContain("ESC pressed");
  });
});
