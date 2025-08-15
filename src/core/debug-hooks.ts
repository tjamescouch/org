export async function installDebugHooks(): Promise<void> {
  const MAX = Number(process.env.LOCK_MAX_MS ?? 1200);

  // Patch ChannelLock at runtime (prototype monkey-patch)
  try {
    const mod: any = await import("../core/channel-lock");
    const proto = mod?.ChannelLock?.prototype;
    if (proto && !proto.__orgPatched) {
      const unlockName = ["unlock", "release", "free", "unlockAsync"].find(n => typeof proto[n] === "function");
      const origUnlock = unlockName ? proto[unlockName] : undefined;
      const origAcquire = typeof proto.acquire === "function" ? proto.acquire : undefined;

      if (origAcquire) {
        proto.acquire = function (...args: any[]) {
          // kick off a watchdog timer if not present
          if (!this.__watchdog) {
            this.__watchdog = setInterval(() => {
              if (this.locked && this.queue && this.queue.length > 0 && this.__heldSince && Date.now() - this.__heldSince > MAX) {
                console.debug(`[DEADLOCK] channel-lock held for ${Date.now() - this.__heldSince}ms with queueLength=${this.queue.length}. Forcibly releasing.`);
                this.locked = false;
                this.__heldSince = null;
                const next = this.queue.shift();
                if (typeof next === "function") try { next(); } catch {}
              }
            }, Math.min(MAX, 500));
          }
          return origAcquire.apply(this, args);
        };
      }

      if (origUnlock) {
        proto[unlockName!] = function (...args: any[]) {
          this.__heldSince = null;
          const out = origUnlock.apply(this, args);
          return out;
        };
      }

      // Track when the lock actually becomes held
      const holdSetter = function (this: any, v: boolean) {
        this._locked = v;
        if (v) this.__heldSince = Date.now();
      };
      try {
        // If the class exposes 'locked', we redefine its setter to record hold start
        const desc = Object.getOwnPropertyDescriptor(proto, "locked");
        if (desc && (desc.set || desc.get)) {
          Object.defineProperty(proto, "locked", { configurable: true, get: desc.get ?? function(){ return this._locked; }, set: holdSetter });
        } else {
          // Fallback: wrap places that assign .locked=true at runtime via acquire() above
          // __heldSince is also updated by the watchdog when it detects a held lock
        }
      } catch { /* non-fatal */ }

      proto.__orgPatched = true;
      console.info("debug-hooks: ChannelLock watchdog active (MAX=", MAX, "ms)");
    }
  } catch (e) {
    console.warn("debug-hooks: ChannelLock patch skipped:", e?.message ?? e);
  }
}
