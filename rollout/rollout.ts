import { writeFileSync } from "fs";
import { evaluate } from "./fitness";
import { gitAddAll, gitBranch, gitCommit } from "./git-utils";

function setActive(color: "blue"|"green") {
  writeFileSync("./deployment.json", JSON.stringify({ active: color }, null, 2));
}

async function main() {
  await gitBranch("candidate");

  const blue = await evaluate("blue");
  const green = await evaluate("green");

  const chooseGreen = green.passed && (!blue.passed);

  if (chooseGreen) {
    setActive("green");
    await gitAddAll();
    await gitCommit("rollout: promote green to active");
    console.log("✅ Promoted GREEN to active");
  } else {
    setActive("blue");
    await gitAddAll();
    await gitCommit("rollout: keep blue active");
    console.log("ℹ️  Kept BLUE active");
  }

  console.log("Blue:", blue.metrics, "Green:", green.metrics);
}

main().catch(e => { console.error(e); process.exit(1); });