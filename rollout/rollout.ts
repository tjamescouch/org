import { writeFileSync } from "fs";
import { evaluate } from "./fitness";
import { gitAddAll, gitBranch, gitCommit } from "./git-utils";
import { allowPromotion, summarize, score } from "../policy";

function setActive(color: "blue"|"green") {
  writeFileSync("./deployment.json", JSON.stringify({ active: color }, null, 2));
}

async function main() {
  await gitBranch("candidate");

  const blue  = await evaluate("blue");
  const green = await evaluate("green");

  console.log("BLUE ", summarize(blue.metrics), "score=", score(blue.metrics));
  console.log("GREEN", summarize(green.metrics), "score=", score(green.metrics));

  const promote = allowPromotion(green.metrics, blue.metrics);

  if (promote) {
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
}

main().catch(e => { console.error(e); process.exit(1); });
