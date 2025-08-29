import { Logger } from "../logger";
const ON = process.env.ORG_TRACE === "1";

export function trace(scope: string, msg: string, meta?: unknown) {
  if (!ON) return;
  if (meta === undefined) Logger.info(`[TRACE] ${scope}: ${msg}`);
  else Logger.info(`[TRACE] ${scope}: ${msg} %o`, meta);
}