
export abstract class ExecutionGuard {
  /** Return false to veto execution. Can be async. */
  abstract allow(cmd: string): Promise<boolean> | boolean;
}

export class NoDangerousRm extends ExecutionGuard {
  async allow(cmd: string) {
    return !/rm\s+-rf\s+\/\b/.test(cmd);
  }
}

export class NoRm extends ExecutionGuard {
  async allow(cmd: string) {
    return !/rm\s+.*/.test(cmd);
  }
}

export class NoGitPush extends ExecutionGuard {
  async allow(cmd: string) {
    return !/git\s+push\s+.*/.test(cmd);
  }
}
