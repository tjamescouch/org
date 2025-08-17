export enum ExecutionMode {
    SAFE = "SAFE",
    DIRECT = "DIRECT"
}

export class ExecutionGate {
    private static mode: ExecutionMode = ExecutionMode.SAFE;

    static setMode(_mode: ExecutionMode): void {
        ExecutionGate.mode = _mode;
    }

    static async gate(msg: string): Promise<void> {

        if (!process.stdin.isTTY && ExecutionGate.mode === ExecutionMode.SAFE) {
            throw new Error("Safe mode and non TTY are not compatible");
        }

        if (ExecutionGate.mode != ExecutionMode.SAFE) {
            return;
        }

        Logger.info(`\nContinue? [y/N] ${msg}`);

        await this.waitForEnter();
    }

    // Pause for Enter when safe mode is enabled.  Returns a promise that
    // resolves once the user presses Enter.  If stdin is not a TTY this
    // resolves immediately.
    waitForEnter(msg: string): Promise<void> {
        if (process.stdin.isTTY) {
            return new Promise((resolve, reject) => {
                process.stdin.resume();
                process.stdin.once('data', (data: Buffer) => {
                    const s = data.toString("utf8");
                    if (s.trim() !== "y") {
                        reject();
                    } else {
                        resolve();
                    }
                });
            });
        }
    }
}