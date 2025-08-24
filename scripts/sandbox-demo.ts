import { sandboxedSh, finalizeSandbox } from "../src/tools/sandboxed-sh";

(async () => {
  const ctx = { projectDir: process.cwd(), agentSessionId: "demo" };
  await sandboxedSh({ cmd: "echo 'demo ok' >> demo.txt" }, ctx);
  await sandboxedSh({ cmd: "sed -n '1,3p' README.md || true" }, ctx);
  const res = await finalizeSandbox(ctx);
  console.log("Run dir:", res?.manifestPath?.replace(/manifest\.json$/,""));
  console.log("Patch   :", res?.patchPath || "(empty)");
})();
