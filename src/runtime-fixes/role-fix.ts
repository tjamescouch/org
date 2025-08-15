import { Logger } from "../logger";
(async () => {
  try {
    const mod = await import("../core/chat-room");
    const ChatRoom: any = (mod as any).ChatRoom ?? (mod as any).default ?? mod;
    const P = ChatRoom?.prototype ?? ChatRoom;
    const desc = P && Object.getOwnPropertyDescriptor(P, "receive");
    if (!P || typeof P.receive !== "function") { Logger.debug("role-fix: receive not found; skip"); return; }
    if (desc && desc.writable === false) { Logger.debug("role-fix: receive not writable; skip"); return; }
    if ((P as any).__roleFixPatched) return;
    (P as any).__roleFixPatched = true;

    const orig = P.receive;
    P.receive = function (...a: any[]) {
      try {
        if (a.length >= 2 && a[1] === "user" && a[0] && a[0] !== "User") {
          Logger.debug(`[role-fix] Coercing ${a[0]} user→assistant`);
          a[1] = "assistant";
        } else if (a.length === 1 && typeof a[0] === "object" && a[0]?.role === "user" && a[0]?.from && a[0]?.from !== "User") {
          Logger.debug(`[role-fix] Coercing ${a[0].from} user→assistant`);
          a[0] = { ...a[0], role: "assistant" };
        }
      } catch {}
      return orig.apply(this, a);
    };
    Logger.info("role-fix: ChatRoom.receive patched");
  } catch (e:any) {
    Logger.debug("role-fix: load skipped:", e?.message ?? e);
  }
})();
