import { runOrgInTmux } from "../helpers/tmux-run";
import * as path from "path";

it.skip("ESC in interactive (tmux) applies patch only on 'y'", async () => {
  const repo = path.resolve(__dirname, "..", "fixtures", "tiny-repo");
  const r = await runOrgInTmux({
    bin: "org",
    cwd: repo,
    args: ["--ui","tmux","--review","ask","--prompt","hi"], // run with tmux UI
    sends: [
      { delay: 1200, keys: "Escape" },  // bring up your finalize/prompt
      { delay: 300,  keys: "y Enter" }, // accept
    ]
  });
  expect(r.out).toContain("Apply this patch?"); // your app’s prompt
  // assert final log lines as needed
});
