export async function promptLine(q: string): Promise<string> {
  // Node & Bun both support readline interface
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const res = await new Promise<string>((resolve) => rl.question(q, resolve));
  rl.close();
  return res;
}
