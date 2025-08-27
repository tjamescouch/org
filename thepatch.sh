diff --git a/src/input/controller.ts b/src/input/controller.ts
index 63829b2..db580b1 100644
--- a/src/input/controller.ts
+++ b/src/input/controller.ts
@@ -1,407 +1,179 @@
+
+// src/input/controller.ts
+import * as fs from "fs";
+import * as path from "path";
+import { Logger } from "../logger";
+import type { AskUserFn } from "../scheduler/types";
+
 /**
- * Input controller that guarantees keystrokes are NOT echoed unless
- * we are actively capturing user text (interjection or scheduler prompt).
- *
- * - Idle: raw TTY, no echo. We listen for a hotkey (default "i") to interject.
- * - Prompting: canonical line mode via readline, echo ON, line editing enabled.
- *   After submit, we restore raw/no-echo and reattach the hotkey listener.
- *
- * Adds graceful shutdown on ESC:
- *   - Stops the scheduler
- *   - Calls an injected finalizer (or finalizeAllSandboxes)
- *   - Exits (skips exit when constructed in test mode)
+ * Minimal, single-owner terminal input handler implemented as a finite-state
+ * machine (FSM). This replaces the previous mixture of readline/raw handlers
+ * and guarantees we never double-attach listeners nor leave the terminal in
+ * the wrong mode.
+ *
+ * States:
+ *  - IDLE           : not collecting user text
+ *  - INTERJECT      : collecting a single line of user text
+ *  - EXITING        : shutting down after ESC/EOF
  */
-export class InputController {
-  // … (old implementation removed)
-}
+export class InputController {
+  private state: "IDLE" | "INTERJECT" | "EXITING" = "IDLE";
+  private readonly interjectKey: string;
+  private readonly banner: string;
+  private readonly finalizer?: () => Promise<void> | void;
+
+  private buffer: Buffer[] = [];
+  private pendingResolver: ((s: string | null) => void) | null = null;
+
+  constructor(opts: { interjectKey?: string; interjectBanner?: string; finalizer?: () => Promise<void> | void } = {}) {
+    this.interjectKey = String(opts.interjectKey || "i");
+    this.banner = String(opts.interjectBanner || "You: ");
+    this.finalizer = opts.finalizer;
+
+    // single owner of stdin
+    const s = process.stdin;
+    s.setEncoding("binary");
+    if (s.isTTY) s.setRawMode?.(true);
+    s.resume();
+    s.on("data", this.onKey);
+    process.once("exit", () => {
+      try { if (s.isTTY) s.setRawMode?.(false); } catch {}
+    });
+  }
+
+  /** scheduler hook: prompt user once and return the line (or null if cancelled) */
+  public readonly askUser: AskUserFn = async (_fromAgent: string, content: string) => {
+    if (this.state === "EXITING") return null;
+    if (content && content.trim().length) Logger.info(content);
+    this.startInterject();
+    return await new Promise<string | null>((resolve) => { this.pendingResolver = resolve; });
+  };
+
+  /** convenience: optional kickoff -> send through provided callback */
+  public async askInitialAndSend(kickoff: string | boolean | undefined, send: (line: string) => Promise<void>): Promise<void> {
+    if (kickoff === true) {
+      this.startInterject();
+      const text = await new Promise<string | null>((resolve) => { this.pendingResolver = resolve; });
+      if (text) await send(text);
+      return;
+    }
+    if (typeof kickoff === "string" && kickoff.trim()) {
+      await send(kickoff.trim());
+    }
+  }
+
+  /** API compatibility with previous code path */
+  public attachScheduler(_s: any) { /* no-op */ }
+
+  // ===== FSM =====
+
+  private startInterject(seed?: Buffer) {
+    if (this.state === "EXITING") return;
+    this.state = "INTERJECT";
+    this.buffer = [];
+    process.stdout.write(`${this.banner}`);
+    if (seed?.length) { this.buffer.push(seed); process.stdout.write(seed.toString("utf8")); }
+  }
+
+  private commitInterject() {
+    const text = Buffer.concat(this.buffer).toString("utf8");
+    this.buffer = [];
+    process.stdout.write("\n");
+    const resolver = this.pendingResolver; this.pendingResolver = null;
+    this.state = "IDLE";
+    if (resolver) resolver(text || null);
+  }
+
+  private cancelInterject() {
+    this.buffer = [];
+    process.stdout.write("\n");
+    const resolver = this.pendingResolver; this.pendingResolver = null;
+    this.state = "IDLE";
+    if (resolver) resolver(null);
+  }
+
+  private readonly onKey = (chunk: Buffer | string) => {
+    if (this.state === "EXITING") return;
+
+    const s = Buffer.isBuffer(chunk) ? chunk.toString("binary") : chunk;
+
+    const isEnter = s === "\r" || s === "\n";
+    const isEsc = s === "\x1b";
+    const isCtrlC = s === "\x03";
+    const isBackspace = s === "\x7f" || s === "\b";
+    const isInterjectHotkey = (s === this.interjectKey);
+
+    // Global
+    if (isCtrlC) {
+      this.state = "EXITING";
+      try { if (process.stdin.isTTY) process.stdin.setRawMode?.(false); } catch {}
+      process.stdout.write("\n");
+      process.exit(130);
+      return;
+    }
+
+    if (this.state === "IDLE") {
+      if (isEsc) {
+        this.state = "EXITING";
+        (async () => {
+          try { await this.finalizer?.(); } catch {}
+          try { if (process.stdin.isTTY) process.stdin.setRawMode?.(false); } catch {}
+          process.stdout.write("\n");
+          process.exit(0);
+        })();
+        return;
+      }
+      if (isInterjectHotkey) { this.startInterject(); return; }
+      if (this.isPrintable(s)) { this.startInterject(Buffer.from(s, "binary")); process.stdout.write(s); return; }
+      return;
+    }
+
+    // INTERJECT
+    if (this.state === "INTERJECT") {
+      if (isEsc) { this.cancelInterject(); return; }
+      if (isEnter) { this.commitInterject(); return; }
+      if (isBackspace) {
+        if (this.buffer.length) {
+          const last = this.buffer.pop()!;
+          const str = last.toString("utf8");
+          const trimmed = str.slice(0, Math.max(0, str.length - 1));
+          const newBuf = Buffer.from(trimmed, "utf8");
+          if (newBuf.length) this.buffer.push(newBuf);
+          process.stdout.write("\x1b[1D\x1b[0K");
+        }
+        return;
+      }
+      if (this.isPrintable(s)) {
+        this.buffer.push(Buffer.from(s, "binary"));
+        process.stdout.write(s);
+      }
+    }
+  };
+
+  private isPrintable(s: string): boolean {
+    if (!s) return false;
+    if (s === "\x1b" || s === "\r" || s === "\n" || s === "\x03") return false;
+    return true;
+  }
+}
diff --git a/src/input/tty.ts b/src/input/tty.ts
deleted file mode 100644
index 0e8bcd5..0000000
--- a/src/input/tty.ts
+++ /dev/null
@@ -1,240 +0,0 @@
-// (removed – legacy helper; FSM controller now owns TTY)
-// … previous implementation elided …

