// scripts/sandbox-demo.ts
import { sandboxedSh, finalizeSandbox } from "../src/tools/sandboxed-sh";

(async () => {
  const ctx = { projectDir: process.cwd(), agentSessionId: "demo", policy: { image: "localhost/org-build:debian-12" } };
  await sandboxedSh({ cmd: "mkdir -p tmp && echo 'demo ok' >> tmp/demo.txt && echo 'stdout hello'" }, ctx);
  const res = await finalizeSandbox(ctx);
  console.log("Run dir:", res?.manifestPath?.replace(/manifest\\.json$/,''));
  console.log("Patch   :", res?.patchPath || "(empty)");
})();
