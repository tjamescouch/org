// rollout/sh.ts — tiny Bun-based subprocess helper with timeout and sane output
// Usage: const { code, out, err } = await sh("make", ["-s"], { cwd: ".", timeoutMs: 120_000 });

export type ShResult = { code: number; out: string; err: string };

export async function sh(
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<ShResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = opts.timeoutMs ?? 120_000; // default 2 minutes
  let killed = false;
  const timer = setTimeout(() => {
    try { proc.kill(); killed = true; } catch {}
  }, timeoutMs);

  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (killed) {
      return { code: code || 124, out, err: (err || "") + `\n[sh] timeout after ${timeoutMs}ms` };
    }
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

// Convenience wrappers -------------------------------------------------------
export async function which(bin: string, cwd?: string): Promise<string | null> {
  const r = await sh("which", [bin], { cwd, timeoutMs: 10_000 });
  return r.code === 0 ? r.out.trim() : null;
}

export async function hasFile(path: string): Promise<boolean> {
  try {
    const f = Bun.file(path);
    return await f.exists();
  } catch { return false; }
}

export async function runMake(cwd = "."): Promise<ShResult> {
  const makeBin = (await which("make", cwd)) ?? "make";
  return sh(makeBin, ["-s"], { cwd, timeoutMs: 180_000 });
}

export async function runCtest(cwd = "."): Promise<ShResult> {
  const ctest = (await which("ctest", cwd)) ?? "ctest";
  return sh(ctest, ["--output-on-failure"], { cwd, timeoutMs: 180_000 });
}

export async function medianMs(fn: () => Promise<ShResult>, n = 3): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fn();
    // consider non-zero exit a very slow run; encode as big number
    const t1 = performance.now();
    times.push(r.code === 0 ? (t1 - t0) : 9e9);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}
