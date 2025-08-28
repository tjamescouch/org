import { spawnSync } from "child_process";

process.env.SANDBOX_BACKEND = "mock";

function sweep(reason: string) {
  try {
    if (process.platform === "win32") return; // not needed here
    // Look for org test runs we marked with ORG_TEST_RUN=1 in the command line
    // (on mac/Linux, Bun shows argv including our env markers for ps output).
    const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
    const lines = (ps.stdout || "").split("\n");
    const targets = lines
      .map((l) => l.trim())
      .filter((l) => l.includes("/src/app.ts") && l.includes("ORG_TEST_RUN=1"))
      .map((l) => parseInt(l.split(/\s+/, 1)[0]!, 10))
      .filter((n) => Number.isFinite(n));

    for (const pid of targets) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    // Give them a moment, then SIGKILL any stubborn ones
    setTimeout(() => {
      for (const pid of targets) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }, 250);
  } catch {
    // best-effort; ignore
  }
}

afterEach(() => sweep("afterEach"));
afterAll(() => sweep("afterAll"));
