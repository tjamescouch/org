import { Logger } from "../logger";

function coerceArgs(args: any[]) {
  // receive(msg) OR receive(from, role, content, meta?)
  if (args.length === 1 && typeof args[0] === "object" && args[0]) {
    const m = args[0];
    if (m && m.role === "user" && m.from && m.from !== "User") {
      Logger.debug(`[role-fix] Coercing ${m.from} user→assistant (object)`);
      args[0] = { ...m, role: "assistant" };
    }
  } else if (args.length >= 2) {
    const from = args[0];
    const role = args[1];
    if (role === "user" && from && from !== "User") {
      Logger.debug(`[role-fix] Coercing ${from} user→assistant (positional)`);
      args[1] = "assistant";
    }
  }
  return args;
}

(async () => {
  try {
    const mod = await import("../core/chat-room");
    const CR:any = (mod as any).ChatRoom ?? (mod as any).default ?? mod;
    const P = CR?.prototype ?? CR;
    if (!P || typeof P.receive !== "function") {
      Logger.warn("role-fix: ChatRoom.receive not found; no fix applied");
      return;
    }
    if ((P as any).__roleFixPatched) return;
    (P as any).__roleFixPatched = true;

    const orig = P.receive;
    P.receive = function (...a: any[]) {
      try { a = coerceArgs(a); } catch {}
      return orig.apply(this, a);
    };
    Logger.info("role-fix: ChatRoom.receive patched (non-User user→assistant)");
  } catch (e:any) {
    Logger.warn("role-fix: failed to install:", e?.message ?? e);
  }
})();
