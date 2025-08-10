// autopilot.ts — run continuous self-improvement cycles
import { writeFileSync, appendFileSync } from "fs";
import { evaluate } from "./rollout/fitness";
import { gitAddAll, gitBranch, gitCommit } from "./rollout/git-utils";

function setActive(color: "blue"|"green") {
  writeFileSync("./deployment.json", JSON.stringify({ active: color }, null, 2));
}

async function promoteGreen() {
  setActive("green");
  await gitAddAll();
  await gitCommit(`rollout: promote green to active @ ${new Date().toISOString()}`);
}

async function keepBlue() {
  setActive("blue");
  await gitAddAll();
  await gitCommit(`rollout: keep blue active @ ${new Date().toISOString()}`);
}

function log(line: string) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  appendFileSync("./rollout.log", msg);
  console.log(msg.trim());
}

async function once(): Promise<"promoted"|"kept"> {
  await gitBranch("candidate");

  const blue  = await evaluate("blue");
  const green = await evaluate("green");

  log(`metrics blue=${JSON.stringify(blue.metrics)} green=${JSON.stringify(green.metrics)}`);

  const greenWins = green.passed && !blue.passed; // expand with more metrics later

  if (greenWins) {
    await promoteGreen();
    log("✅ promoted green");
    return "promoted";
  } else {
    await keepBlue();
    log("ℹ️ kept blue");
    return "kept";
  }
}

async function main() {
  const SLEEP_MS = 5 * 60 * 1000;     // run every 5 minutes
  const MAX_PROMOTIONS_PER_DAY = 12;  // guardrail

  let promotedToday = 0;
  let lastDay = new Date().getUTCDate();

  for (;;) {
    const now = new Date();
    if (now.getUTCDate() !== lastDay) { promotedToday = 0; lastDay = now.getUTCDate(); }

    try {
      const res = await once();
      if (res === "promoted") promotedToday++;

      if (promotedToday >= MAX_PROMOTIONS_PER_DAY) {
        log("⏸️ hit daily promotion cap; pausing until tomorrow");
        // sleep until next UTC day
        const t = new Date(); t.setUTCHours(24,0,0,0);
        await new Promise(r => setTimeout(r, t.getTime() - now.getTime()));
        continue;
      }
    } catch (e) {
      log(`❌ autopilot error: ${(e as Error).message}`);
    }

    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
}

main().catch(e => { console.error(e); process.exit(1); });