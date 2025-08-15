export async function installDebugHooks(): Promise<void> {
  const MAX = Number(process.env.LOCK_MAX_MS ?? 1300);

  try {
    const mod: any = await import("../core/channel-lock");
    const proto = mod?.ChannelLock?.prototype;
    if (!proto || proto.__orgPatched) return;

    // Ensure a per-instance watchdog
    const ensureWatchdog = (self: any) => {
      if (self.__watchdog) return;
      self.__watchdog = setInterval(() => {
        // Start clock lazily if we notice a held lock with queue
        if (self.locked && !self.__heldSince) self.__heldSince = Date.now();
        if (self.locked && self.queue && self.queue.length > 0 && self.__heldSince) {
          const age = Date.now() - self.__heldSince;
          if (age > MAX) {
            console.debug(`[DEADLOCK] channel-lock held for ${age}ms with queueLength=${self.queue.length}. Forcibly releasing.`);
            self.locked = false;
            self.__heldSince = null;
            const next = self.queue.shift();
            if (typeof next === "function") { try { next(); } catch {} }
          }
        }
      }, Math.min(MAX, 500));
    };

    const origAcquire = typeof proto.acquire === "function" ? proto.acquire : undefined;
    const unlockName = ["unlock", "release", "free", "unlockAsync"].find(n => typeof proto[n] === "function");
    const origUnlock = unlockName ? proto[unlockName] : undefined;

    if (origAcquire) {
      proto.acquire = function (...args: any[]) {
        ensureWatchdog(this);
        const out = origAcquire.apply(this, args);
        // Try to start clock soon after acquire (covers immediate case)
        setTimeout(() => { if (this.locked && !this.__heldSince) this.__heldSince = Date.now(); }, 0);
        return out;
      };
    }

    if (origUnlock) {
      proto[unlockName!] = function (...args: any[]) {
        this.__heldSince = null;
        const out = origUnlock.apply(this, args);
        return out;
      };
    }

    proto.__orgPatched = true;
    console.info("debug-hooks: ChannelLock watchdog active (MAX", MAX, "ms)");
  } catch (e) {
    console.warn("debug-hooks: ChannelLock patch skipped:", (e as any)?.message ?? e);
  }
}
