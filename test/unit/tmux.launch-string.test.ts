// tests/unit/tmux.launch-string.test.ts
import { describe, it, expect } from "bun:test";
import { buildTmuxLaunchScript } from "../../src/ui/tmux/launch"; // expose pure builder

describe("tmux launch string builder", () => {
  it("does not over-escape and writes sane script", () => {
    const s = buildTmuxLaunchScript({
      entry: "/work/src/app.ts",
      bunBin: "/usr/local/bin/bun",
      tmuxTmp: "/work/.org/logs/tmux-logs",
    });
    expect(s).toContain("bash -lc");
    expect(s).toContain("/usr/bin/tmux -vv new-session");
    expect(s.match(/\\\\+/g)?.length ?? 0).toBeLessThan(10); // crude guard on runaway backslashes
    expect(s).toContain("/work/.org/tmux-inner.sh");
  });
});
