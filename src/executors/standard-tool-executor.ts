// src/executors/standard-tool-executor.ts
import { Logger, C } from "../logger";
import { runSh } from "../tools/sh";
import { sanitizeContent } from "../utils/sanitize-content";
import type { ExecuteToolsParams, ExecuteToolsResult } from "./tool-executor";
import { ToolExecutor } from "./tool-executor";

/**
 * StandardToolExecutor
 * Extracted from LlmAgent: executes "sh" (and alias "exec") tool calls,
 * streams outputs into memory, and consults the GuardRail.
 * Pure refactor — no functional changes.
 */
export class StandardToolExecutor extends ToolExecutor {
  async execute(params: ExecuteToolsParams): Promise<ExecuteToolsResult> {
    const {
      calls,
      maxTools,
      abortCallback,
      guard,
      memory,
      finalText,
      agentId,
    } = params;

    let totalUsed = 0;
    let forceEndTurn = false;

    for (const tc of calls) {
      if (abortCallback?.()) {
        Logger.debug("Aborted tool calls");
        break;
      }

      if (forceEndTurn) Logger.warn("Turn forcibly ended.");
      if (totalUsed >= maxTools || forceEndTurn) break;

      const name = tc.function?.name || "";
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }

      if (name === "sh" || name === "exec") { // The Model likes to use the alias exec for some reason
        const rawCmd = String(args?.cmd ?? "");
        const cmd = sanitizeContent(rawCmd);

        if (!cmd) {
          const decision = guard.noteBadToolCall({
            name: "sh",
            reason: "missing-arg",
            missingArgs: ["cmd"],
          });
          if (decision?.nudge) {
            await memory.add({ role: "system", content: decision.nudge, from: "System" });
          }
          if (decision?.endTurn) {
            Logger.warn(`System ended turn due to bad tool call.`);
            totalUsed = maxTools; // consume budget → end turn
            forceEndTurn = true;
            if (finalText) await memory.add({ role: "system", content: finalText, from: "System" });
            break;
          }

          // Synthesize a failed tool-output message back to memory (as before).
          const content = JSON.stringify({
            ok: false,
            stdout: "",
            stderr: "Execution failed: Command required.",
            exit_code: 1,
            cmd: "",
          });
          Logger.warn(`Execution failed: Command required.`);
          await memory.add({ role: "tool", content, tool_call_id: tc.id, name, from: name });
          totalUsed++;
          continue;
        }

        // Normal execution
        Logger.debug(`${agentId} tool ->`, { name, cmd: cmd.slice(0, 160) });
        const tSh = Date.now();
        const result = await runSh(cmd);
        Logger.debug(`${agentId} tool <-`, { name, ms: Date.now() - tSh, exit: result.exit_code, outChars: result.stdout.length, errChars: result.stderr.length });

        // Let GuardRail see the signature to stop "same command" repetition
        const repeatDecision = guard.noteToolCall({
          name: "sh",
          argsSig: cmd, // argument signature = canonicalized cmd
          resSig: `${result.exit_code}|${(result.stdout || "").trim().slice(0, 240)}`,
          exitCode: result.exit_code,
        });
        if (repeatDecision?.nudge) {
          await memory.add({ role: "system", content: repeatDecision.nudge, from: "System" });
        }
        if (repeatDecision?.endTurn) {
          // Still record the tool output so the model can read it later.
          const contentJSON = JSON.stringify(result);
          await memory.add({ role: "tool", content: contentJSON, tool_call_id: tc.id, name: "sh", from: "Tool" });

          totalUsed = maxTools;
          forceEndTurn = true;
          if (finalText) await memory.add({ role: "assistant", content: finalText, from: "Me" });
          break;
        }

        const content = JSON.stringify(result);
        await memory.add({ role: "tool", content, tool_call_id: tc.id, name: "sh", from: "Tool" });
        totalUsed++;
      } else {
        Logger.warn(`\nUnknown tool ${name} requested`, tc);
        const content = JSON.stringify({ ok: false, stdout: "", stderr: `unknown tool: ${name}`, exit_code: 2, cmd: "" });
        await memory.add({ role: "tool", content, tool_call_id: tc.id, name, from: "Tool" });
        totalUsed++;
      }
    }

    return { totalUsed, forceEndTurn };
  }
}
