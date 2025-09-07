// src/executors/standard-tool-executor.ts
import { ChatToolCall } from "../drivers/types";
import { GuardRail } from "../guardrails/guardrail";
import { Logger, C } from "../logger";
import { AgentMemory } from "../memory";
import { runSh, ToolResult } from "../tools/sh";
import type { ExecuteToolsParams, ExecuteToolsResult } from "./tool-executor";
import { ToolExecutor } from "./tool-executor";


interface ToolHandlerResult {
    stdout: string;
    stderr: string;
    ok: boolean;
    exit_code: number;
    toolsUsed: number;
    forceEndTurn: boolean;
}

type ToolHandler = (agentId: string, toolcall: ChatToolCall, text: string, memory: AgentMemory, guard: GuardRail) => Promise<ToolHandlerResult>;

const formatToolResult = (tr: ToolResult): string => {
    return `ok: ${tr.ok} code: ${tr.exit_code} stdout: ${tr.stdout} stderr: ${tr.stderr}`;
}


const shHandler = async (agentId: string, toolcall: ChatToolCall, text: string, memory: AgentMemory, guard: GuardRail): Promise<ToolHandlerResult> => {
    let args: any = {};
    try { args = JSON.parse(toolcall.function?.arguments || "{}"); } catch { args = {}; }
    const hasApplyPatch = text.match(/apply_patch <</);
    const rawCmd =  String(args?.cmd ?? "");
    const cmd = hasApplyPatch ? 'sh' : rawCmd;
    const name = toolcall.function?.name || "";

    let toolsUsed = 1;

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
            if (text) await memory.add({ role: "system", content: text, from: "System" });
            return { toolsUsed, forceEndTurn: true, stdout: "", stderr: "System ended turn due to bad tool call", ok: false, exit_code: 1 };
        }

        // Synthesize a failed tool-output message back to memory (as before).
        const content = JSON.stringify({
            ok: false,
            stdout: "",
            stderr: "Execution failed: Command required.",
            exit_code: 1,
            cmd: "",
        });
        Logger.warn(`Execution failed: Command required.`, {...toolcall, cmd});
        await memory.add({ role: "tool", content, tool_call_id: toolcall.id, name, from: "Tool" });

        return { toolsUsed, forceEndTurn: false, stdout: "", stderr: "System aborted shell call tue to missing command.", ok: false, exit_code: 2 };
    }

    Logger.debug(`${agentId} tool ->`, { name, cmd: cmd.slice(0, 160) });
    const t = Date.now();
    const result = await runSh(cmd)
    Logger.info(C.bold(formatToolResult(result)) );
    Logger.debug(`${agentId} tool <-`, { name, ms: Date.now() - t, exit: result.exit_code, outChars: result.stdout.length, errChars: result.stderr.length });

    // Let GuardRail see the signature to stop "same command" repetition
    const repeatDecision = guard.noteToolCall({
        name: "sh",
        argsSig: cmd, // argument signature = canonicalized cmd
        resSig: `${result.exit_code}|${(result.stdout || result.stderr || "").trim().slice(0, 240)}`,
        exitCode: result.exit_code,
    });
    if (repeatDecision?.nudge) {
        await memory.add({ role: "system", content: repeatDecision.nudge, from: "System" });
    }
    if (repeatDecision?.endTurn) {
        // Still record the tool output so the model can read it later.
        const contentJSON = JSON.stringify(result);
        await memory.add({ role: "tool", content: contentJSON, tool_call_id: toolcall.id, name: "sh", from: "Tool" });

        if (text) await memory.add({ role: "assistant", content: text, from: "Me" });
        return { toolsUsed: 0, forceEndTurn: true, stdout: result.stdout, stderr: result.stderr, ok: result.exit_code === 0, exit_code: result.exit_code };
    }

    const content = JSON.stringify(result);
    await memory.add({ role: "tool", content, tool_call_id: toolcall.id, name: "sh", from: "Tool" });

    return { toolsUsed, forceEndTurn: false, stdout: result.stdout, stderr: result.stderr, ok: result.exit_code === 0, exit_code: result.exit_code };
}


//const vimdiffHandler = async (agentId: string, toolcall: ChatToolCall, text: string, memory: AgentMemory, guard: GuardRail): Promise<ToolHandlerResult> => {
//    const name = toolcall.function?.name || "";
//    let args: any = {};
//    try { args = JSON.parse(toolcall.function?.arguments || "{}"); } catch { args = {}; }
//    Logger.debug(`${agentId} tool ->`, { name, toolcall });
//    const t = Date.now();
//    const result = await runVimdiff({ left: args.left, right: args.right, cwd: args.cwd });
//    Logger.debug(`${agentId} tool <-`, { name, ms: Date.now() - t });
//
//    // Let GuardRail see the signature to stop "same command" repetition
//    const repeatDecision = guard.noteToolCall({
//        name: "vimdiff",
//        argsSig: toolcall.function?.arguments, // argument signature = canonicalized cmd
//        resSig: `N/A`,
//        exitCode: 0,
//    });
//    if (repeatDecision?.nudge) {
//        await memory.add({ role: "system", content: repeatDecision.nudge, from: "System" });
//    }
//    if (repeatDecision?.endTurn) {
//        // Still record the tool output so the model can read it later.
//        const contentJSON = JSON.stringify(result);
//        await memory.add({ role: "tool", content: contentJSON, tool_call_id: toolcall.id, name: "sh", from: "Tool" });
//
//        if (text) await memory.add({ role: "assistant", content: text, from: "Me" });
//        return { toolsUsed: 1, forceEndTurn: true, stdout: "vimdiff completed", stderr: '', ok: true, exit_code: 0 };
//    }
//
//    const content = JSON.stringify(result);
//    await memory.add({ role: "tool", content, tool_call_id: toolcall.id, name: "sh", from: "Tool" });
//
//    return { toolsUsed: 1, forceEndTurn: false, stdout: "vimdiff completed", stderr: '', ok: true, exit_code: 0 };
//}

/**
 * StandardToolExecutor
 * Extracted from LlmAgent: executes "sh" (and alias "exec") tool calls,
 * streams outputs into memory, and consults the GuardRail.
 * Pure refactor — no functional changes.
 */
export class StandardToolExecutor extends ToolExecutor {

    private readonly toolHandlers: Record<string, ToolHandler> = {
        sh: shHandler,
        exec: shHandler,
        //vimdiff: vimdiffHandler //FIXME
    };

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

        let toolsUsed = 0;
        let forceEndTurn = false;

        for (const tc of calls) {
            if (abortCallback?.()) {
                Logger.debug("Aborted tool calls");
                break;
            }

            if (forceEndTurn) Logger.warn("Turn forcibly ended.");
            if (toolsUsed >= maxTools || forceEndTurn) break;

            const name = tc.function?.name || "";
            let args: any = {};
            try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }



            const handler = this.toolHandlers[name];

            if (!handler) {
                const cmd = String(args?.cmd ?? "");
                Logger.warn(`\nUnknown tool ${name} requested`, tc);
                const content = JSON.stringify({ ok: false, stdout: "", stderr: `unknown tool: ${name}`, exit_code: 2, tc, cmd });
                await memory.add({ role: "tool", content, tool_call_id: tc.id, name, from: "Tool" });

                return { toolsUsed, forceEndTurn: false };
            }

            const result = await handler(agentId, tc, finalText, memory, guard);
            toolsUsed++;

            if (result.forceEndTurn) {
                forceEndTurn = true;
                break;
            }
        }
        return { toolsUsed, forceEndTurn };
    }
}
