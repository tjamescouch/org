/* Lightweight runtime instrumentation.
 * Enabled with DEBUG_TRACE=1.
 * Attempts to import and wrap common methods; if something is missing we log once.
 */
import { Logger } from "../logger";

const onceWarn = new Set<string>();
function warnOnce(key: string, msg: string){ if(!onceWarn.has(key)){ onceWarn.add(key); Logger.warn(msg); } }
function sanitize(v: any) {
  try {
    if (typeof v === "string") {
      const s = v.replace(/\s+/g, " ").slice(0, 240);
      return s;
    }
    return JSON.stringify(v)?.slice(0, 240);
  } catch { return String(v); }
}
function wrapMethod<T extends object>(obj: T, name: string, label: string){
  const anyObj: any = obj as any;
  if (!anyObj) { warnOnce("wrap:"+label, `debug-hooks: ${label} not found`); return; }
  const orig = anyObj[name];
  if (typeof orig !== "function") { warnOnce("wrap:"+label+name, `debug-hooks: ${label}.${name} not a function`); return; }
  anyObj[name] = async function(...args: any[]){
    const id = Math.random().toString(36).slice(2,7);
    Logger.debug(`${label}.${name}#${id} → args:`, args.map(sanitize));
    const t0 = Date.now();
    try{
      const r = await orig.apply(this, args);
      Logger.debug(`${label}.${name}#${id} ← ok in ${Date.now()-t0}ms`, sanitize(r));
      return r;
    }catch(err:any){
      Logger.error(`${label}.${name}#${id} ← ERROR in ${Date.now()-t0}ms:`, err?.message ?? err);
      throw err;
    }
  };
}

export async function installDebugHooks() {
  Logger.info("debug-hooks: enabling runtime instrumentation");

  // Process safety nets
  process.on("uncaughtException", (e)=> Logger.error("uncaughtException:", e));
  process.on("unhandledRejection", (e)=> Logger.error("unhandledRejection:", e as any));

  try {
    // Channel lock
    const cl = await import("./channel-lock");
    const CL: any = cl?.default ?? cl;
    if (CL?.ChannelLock?.prototype) {
      wrapMethod(CL.ChannelLock.prototype, "acquire", "ChannelLock");
      wrapMethod(CL.ChannelLock.prototype, "release", "ChannelLock");
      wrapMethod(CL.ChannelLock.prototype, "forceRelease", "ChannelLock"); // if exists
    } else {
      warnOnce("cl", "debug-hooks: ChannelLock not located");
    }
  } catch (e) { Logger.warn("debug-hooks: ChannelLock load failed:", (e as any)?.message); }

  try {
    // Turn manager
    const tm = await import("../turn-manager");
    const TM: any = tm?.default ?? tm;
    const P = TM?.TurnManager?.prototype ?? TM?.prototype ?? TM;
    if (P) {
      wrapMethod(P, "takeTurn", "TurnManager");
      wrapMethod(P, "tick", "TurnManager");
      wrapMethod(P, "run", "TurnManager");
    } else {
      warnOnce("tm", "debug-hooks: TurnManager not located");
    }
  } catch (e) { Logger.warn("debug-hooks: TurnManager load failed:", (e as any)?.message); }

  try {
    // Chat transport
    const tr = await import("../transport/chat");
    const TR: any = tr?.default ?? tr;
    if (TR?.chatOnce) {
      wrapMethod(TR, "chatOnce", "transport.chat");
    } else if (TR) {
      for (const k of Object.keys(TR)) {
        if (k.toLowerCase().includes("chat") && typeof (TR as any)[k] === "function") {
          wrapMethod(TR, k, "transport.chat");
        }
      }
    } else {
      warnOnce("tr", "debug-hooks: transport/chat not located");
    }
  } catch (e) { Logger.warn("debug-hooks: transport/chat load failed:", (e as any)?.message); }

  try {
    // ChatRoom
    const cr = await import("../core/chat-room");
    const CR: any = cr?.default ?? cr;
    const P = CR?.ChatRoom?.prototype ?? CR?.prototype ?? CR;
    if (P) {
      for (const m of ["sendUser","sendSystem","sendTo","addModel","receive","broadcast"]) {
        if (typeof (P as any)[m] === "function") wrapMethod(P, m, "ChatRoom");
      }
    } else {
      warnOnce("cr", "debug-hooks: ChatRoom not located");
    }
  } catch (e) { Logger.warn("debug-hooks: ChatRoom load failed:", (e as any)?.message); }

  try {
    // MessageBus (log every emit)
    const mb = await import("../core/message-bus");
    const MB: any = mb?.default ?? mb;
    const P = MB?.MessageBus?.prototype ?? MB?.prototype ?? MB;
    if (P && typeof (P as any).emit === "function") {
      const orig = (P as any).emit;
      (P as any).emit = function(event: string, ...rest: any[]){
        Logger.debug(`MessageBus.emit("${event}")`, rest.map(sanitize));
        return orig.apply(this, [event, ...rest]);
      };
    } else {
      warnOnce("mb", "debug-hooks: MessageBus not located");
    }
  } catch (e) { Logger.warn("debug-hooks: MessageBus load failed:", (e as any)?.message); }

  Logger.info("debug-hooks: installed");
}
