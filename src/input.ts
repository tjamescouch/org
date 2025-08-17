import readline from 'readline';
import { RoundRobinScheduler } from './scheduler';
import { Logger } from './logger';

/** Handles: initial prompt, interject on 'i', and graceful Ctrl+C */
export class InputController {
  private rl: readline.Interface;
  private scheduler: RoundRobinScheduler;

  constructor(scheduler: RoundRobinScheduler) {
    this.scheduler = scheduler;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // raw mode for 'i' interject
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.on('data', this.onKeyData);
    }

    process.on('SIGINT', () => {
      Logger.info('\nExiting.');
      this.shutdown();
    });
  }

  private onKeyData = (buf: Buffer) => {
    const s = buf.toString('utf8');
    if (s === 'i') {
      this.interject();
    } else if (s === '\u0003') { // Ctrl+C
      this.shutdown();
    }
  };

  async askInitial() {
    const text = await this.question('user: ');
    this.scheduler.broadcastUserPrompt(text);
  }

  private async interject() {
    this.scheduler.pause();
    const text = await this.question('\nInterject> ');
    this.scheduler.broadcastUserPrompt(text);
    this.scheduler.resume();
  }

  private question(q: string): Promise<string> {
    return new Promise((res) => this.rl.question(q, (ans) => res(ans)));
  }

  shutdown() {
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.off('data', this.onKeyData);
      }
    } catch {}
    this.rl.close();
    process.exit(0);
  }
}

