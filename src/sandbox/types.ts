export interface ISandboxSession {
  readonly runDir: string;
  start(): Promise<void>;
  exec(cmd: string): Promise<{ ok: boolean; exit: number; stdoutFile: string; stderrFile: string }>;
  finalize(): Promise<{ manifestPath: string; patchPath?: string }>;
  destroy(opts?: { removeScratch?: boolean }): Promise<void>;
}
