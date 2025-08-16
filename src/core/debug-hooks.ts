let INSTALLED = false;

export async function installDebugHooks(): Promise<void> {
  if (INSTALLED) return; INSTALLED = true;
  const lockMax = Number(process.env.LOCK_MAX_MS ?? 1400);
  const chatTimeout = Number(process.env.CHAT_CALL_MAX_MS ?? 25000);
  const serialize = (process.env.SERIALIZE_CHAT ?? "1") !== "0";

  // 3a) ChannelLock watchdog with global registry scan
  try {
    const mod: any = await import("../core/channel-lock");
    const reg: any[] = (mod.__orgRegistry ??= []);
    const proto = mod?.ChannelLock?.prototype;
    if (proto && !proto.__orgPatch) {
      const origAcquire = proto.acquire;
      if (typeof origAcquire === "function") {
        proto.acquire = function (...a: any[]) {
          if (!this.__orgRegistered) { reg.push(this); this.__orgRegistered = true; }
          const p = origAcquire.apply(this, a);
          try { this.__heldSince = Date.now(); } catch (e) { console.error(e) }
          return p;
        };
      }
      const unlockName = ["unlock","release","free","unlockAsync"].find(n => typeof proto[n] === "function");
      if (unlockName) {
        const origUnlock = proto[unlockName];
        proto[unlockName] = function (...a: any[]) {
          this.__heldSince = null;
          return origUnlock.apply(this, a);
        };
      }
      proto.__orgPatch = true;
    }
    if (!mod.__orgSweeper) {
      mod.__orgSweeper = setInterval(() => {
        for (const lk of mod.__orgRegistry as any[]) {
          try {
            if (lk && lk.locked && lk.queue && lk.queue.length > 0) {
              if (!lk.__heldSince) lk.__heldSince = Date.now();
              const age = Date.now() - lk.__heldSince;
              if (age > lockMax) {
                console.debug(`[DEADLOCK] channel-lock held for ${age}ms with queueLength=${lk.queue.length}. Forcibly releasing.`);
                lk.locked = false;
                lk.__heldSince = null;
                const next = lk.queue.shift();
                if (typeof next === "function") { try { next(); } catch (e) { console.error(e) } }
              }
            }
          } catch (e) { console.error(e) }
        }
      }, Math.min(500, lockMax));
      console.info(`debug-hooks: ChannelLock watchdog active (MAX ${lockMax} ms)`);
    }
  } catch (e) {
    console.warn("debug-hooks: ChannelLock watchdog skipped:", (e as any)?.message ?? e);
  }

  // 3b) chatOnce serialization (single flight) with timeout
  try {
    const chatMod: any = await import("../transport/chat");
    if (serialize && chatMod && typeof chatMod.chatOnce === "function" && !chatMod.__orgGated) {
      const orig = chatMod.chatOnce.bind(chatMod);
      let inFlight = false; const waiters: Array<() => void> = [];
      const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (inFlight) await new Promise<void>(r => waiters.push(r));
        inFlight = true;
        try {
          return await Promise.race([
            fn(),
            new Promise<T>((_, rej) => setTimeout(() => rej(new Error("chatOnce timeout")), chatTimeout)),
          ]);
        } finally {
          inFlight = false;
          waiters.shift()?.();
        }
      };
      chatMod.chatOnce = (...a: any[]) => gate(() => orig(...a));
      chatMod.__orgGated = true;
      console.info(`debug-hooks: chatOnce serialized (timeout ${chatTimeout} ms)`);
    }
  } catch (e) {
    console.warn("debug-hooks: serialize chat skipped:", (e as any)?.message ?? e);
  }
}
