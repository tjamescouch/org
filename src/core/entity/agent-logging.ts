/**
 * AgentLog
 *  - tiny wrapper around console for consistent usage + future extension
 */
export class AgentLog {
  static logLine(s: string) { (console.log)(s); }
  static logErr(s: string) { (console.error)(s); }
  static appendDirect(s: string) { console.log(s); }
  static stamp(): string { return new Date().toLocaleTimeString(); }
}

/** Optional flag to surface chain-of-thought (for debugging only). */
export const SHOW_THINK = (process.env.SHOW_THINK === "1" || process.env.SHOW_THINK === "true");

export default AgentLog;
