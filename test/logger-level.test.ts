import { test, expect } from 'bun:test';
import { Logger, LogLevel } from '../src/logger';

/**
 * Verify that the logger honours the LOG_LEVEL environment variable.
 * When LOG_LEVEL=INFO, debug messages should be suppressed but info
 * messages should be logged.  When LOG_LEVEL=NONE, all logs should
 * be suppressed.  This test monkey‑patches console.log to capture
 * messages and restores it after each assertion.
 */
test('Logger respects LOG_LEVEL env', () => {
  const orig = console.log;
  const msgs: string[] = [];
  console.log = (msg?: any) => msgs.push(String(msg));

  // Set INFO level: should log INFO but not DEBUG
  process.env.LOG_LEVEL = 'INFO';
  Logger.setLevel(process.env.LOG_LEVEL!);
  msgs.length = 0;
  Logger.info('info');
  Logger.debug('debug');
  expect(msgs.some(m => m.includes('INFO') && m.includes('info'))).toBe(true);
  expect(msgs.some(m => m.includes('DEBUG') && m.includes('debug'))).toBe(false);

  // Set NONE level: nothing should be logged
  process.env.LOG_LEVEL = 'NONE';
  Logger.setLevel(process.env.LOG_LEVEL!);
  msgs.length = 0;
  Logger.info('info suppressed');
  Logger.error('error suppressed');
  expect(msgs.length).toBe(0);

  // Restore defaults
  delete process.env.LOG_LEVEL;
  Logger.setLevel(LogLevel.DEBUG);
  console.log = orig;
});