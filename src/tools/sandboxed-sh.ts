// src/tools/sandboxed-sh.ts
import * as fs from "fs";
import * as path from "path";
import { SandboxManager } from "../sandbox/session";
import { ExecPolicy } from "../sandbox/policy";
import { detectBackend } from "../sandbox/detect";
import { Logger } from "../logger";

type ToolArgs = { cmd: string };
type ToolResult = { ok: boolean; stdout: string; stderr: string; exit_code: number; cmd: string };

export interface ToolCtx {
    projectDir: string;
    runRoot?: string;
    agentSessionId?: string;
    policy?: Partial<ExecPolicy>;
    logger?: { info: (...a: any[]) => void; error: (...a: any[]) => void };
}

const managers = new Map<string, SandboxManager>();

async function getManager(key: string, projectDir: string, runRoot?: string) {
    let m = managers.get(key);
    if (m) return m;
    m = new SandboxManager(projectDir, runRoot, { backend: "auto" });
    managers.set(key, m);
    return m;
}

export async function sandboxedSh(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
    const sessionKey = ctx.agentSessionId ?? "default";
    const projectDir = ctx.projectDir ?? process.cwd();
    const runRoot = ctx.runRoot ?? path.join(projectDir, ".org");

    const mgr = await getManager(sessionKey, projectDir, runRoot);
    const session = await mgr.getOrCreate(sessionKey, ctx.policy);

    const step = await session.exec(args.cmd);
    const out = fs.existsSync(step.stdoutFile) ? fs.readFileSync(step.stdoutFile, "utf8") : "";
    const err = fs.existsSync(step.stderrFile) ? fs.readFileSync(step.stderrFile, "utf8") : "";

    return { ok: step.ok, stdout: out, stderr: err, exit_code: step.exit, cmd: args.cmd };
}

export async function finalizeSandbox(ctx: ToolCtx) {
    const sessionKey = ctx.agentSessionId ?? "default";

    Logger.info("Finalizing sandbox", sessionKey);
    const m = managers.get(sessionKey);
    if (!m) return;
    return m.finalize(sessionKey);
}

export async function finalizeAllSanboxes() {
    const sandboxeMangers = Object.entries(managers);
    for (const [k, v] of sandboxeMangers) {
        v?.finalize(k);
    }
}

// Optional: expose what backend got selected (useful for debug/tests)
export function selectedSandboxBackend(): string {
    return detectBackend();
}

export const SANDBOXED_SH_TOOL_SCHEMA = {
    type: "function",
    function: {
        name: "sh",
        description: "Run a POSIX shell command inside a sandboxed session. Returns JSON: { ok, stdout, stderr, exit_code, cmd }.",
        parameters: { type: "object", properties: { cmd: { type: "string", description: "Command to run" } }, required: ["cmd"] },
    },
} as const;
