// src/ui/tmux/index.ts
// Launch the tmux UI by writing /work/.org/{tmux.conf, tmux-inner.sh}
// and then starting a private tmux server + attaching to it.

import * as fsp from "fs/promises";
import * as path from "path";
import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";
import { buildTmuxConf, buildInnerScript } from "./config";

function bunBin(): string { return process.env.ORG_BUN_BIN || "/usr/local/bin/bun"; }
function tmuxBin(): string { return process.env.ORG_TMUX_BIN || "/usr/bin/tmux"; }

export async function launchTmuxUI(_argv: string[]): Promise<number> {
  const projectDir = process.env.ORG_PROJECT_DIR || "/work";
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID || "default";

  // If an external bootstrap owns tmux files, do nothing.
  if (process.env.ORG_EXTERNAL_TMUX_BOOTSTRAP === "1") {
    Logger.debug("[tmux] external bootstrap set; skipping internal launcher.");
    return 0;
  }

  const ORG_DIR = "/work/.org";
  const LOG_DIR = path.join(ORG_DIR, "logs");
  await fsp.mkdir(LOG_DIR, { recursive: true });

  // Build files without heredocs to avoid quoting traps.
  const conf = buildTmuxConf();
  const entryCmd = `${bunBin()} /work/src/app.ts --ui console`;
  const inner = buildInnerScript(entryCmd);

  await fsp.writeFile(path.join(ORG_DIR, "tmux.conf"), conf, { encoding: "utf8", mode: 0o600 });
  await fsp.writeFile(path.join(ORG_DIR, "tmux-inner.sh"), inner, { encoding: "utf8", mode: 0o700 });

  const prelude = [
    `touch ${LOG_DIR}/tmux-launcher.log >/dev/null`,
    `echo "[tmux/launcher] begin $(date -Is)" | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`,
    `${tmuxBin()} -V | sed 's/^/[tmux\\/launcher] tmux version: /' | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`,
    `echo "[tmux/launcher] socket label: tmux-0" | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`,
    `echo "[tmux/launcher] conf: ${ORG_DIR}/tmux.conf" | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`,
    `echo "[tmux/launcher] inner: ${ORG_DIR}/tmux-inner.sh" | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`,
  ].join(" && ");

  const tmuxStart = [
    // Detached session; run inner via bash -lc so PATH/ENV match app shells.
    `${tmuxBin()} -vv -L tmux-0 -f ${ORG_DIR}/tmux.conf ` +
      `new-session -d -s org -n main "bash -lc '${ORG_DIR}/tmux-inner.sh'"`,
    // Attach (returns when the client detaches or session ends).
    `${tmuxBin()} -L tmux-0 attach -t org`,
  ].join(" && ");

  const trailer = `echo "[tmux/launcher] end $(date -Is)" | tee -a ${LOG_DIR}/tmux-launcher.log >/dev/null`;
  const script = [prelude, tmuxStart, trailer].join(" && ");

  const { code } = await shInteractive(["bash", "-lc", script], { projectDir, agentSessionId });
  return code ?? 0;
}
