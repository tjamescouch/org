#!/usr/bin/env bash
set -euo pipefail

# 1) Runtime fix: coerce any non-User speaker that arrives as role='user' to role='assistant'
#    We patch ChatRoom.receive generically so we don't need to guess call sites.
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/role-fix.ts <<'TS'
import { Logger } from "../logger";

function coerceArgs(args: any[]) {
  // Two common shapes:
  //   receive(msg)
  //   receive(from, role, content, meta?)
  if (args.length === 1 && typeof args[0] === "object" && args[0]) {
    const m = args[0];
    if (m && m.role === "user" && m.from && m.from !== "User") {
      Logger.debug(`[role-fix] Coercing ${m.from} role user→assistant`);
      args[0] = { ...m, role: "assistant" };
    }
  } else if (args.length >= 2) {
    const from = args[0];
    const role = args[1];
    if (role === "user" && from && from !== "User") {
      Logger.debug(`[role-fix] Coercing ${from} role user→assistant`);
      args[1] = "assistant";
    }
  }
  return args;
}

(async () => {
  try {
    const mod = await import("../core/chat-room");
    const CR: any = (mod as any).default ?? mod;
    const P = CR?.ChatRoom?.prototype ?? CR?.prototype ?? CR;
    if (!P || typeof P.receive !== "function") {
      Logger.warn("role-fix: ChatRoom.receive not found; no fix applied");
      return;
    }
    const orig = P.receive;
    if ((P as any).__roleFixPatched) return;  // idempotent
    (P as any).__roleFixPatched = true;
    P.receive = function (...a: any[]) {
      try { a = coerceArgs(a); } catch {}
      return orig.apply(this, a);
    };
    Logger.info("role-fix: ChatRoom.receive patched (non-User user→assistant)");
  } catch (e:any) {
    Logger.warn("role-fix: failed to install:", e?.message ?? e);
  }
})();
TS

# 2) Expand debug lock tracing to include unlock() if the lock exposes it
DBG=src/core/debug-hooks.ts
if [ -f "$DBG" ]; then
  # Add unlock wrapper once
  if ! grep -q 'wrapMethod(CL.ChannelLock.prototype, "unlock"' "$DBG"; then
    sed -i.bak 's/wrapMethod(CL.ChannelLock.prototype, "release", "ChannelLock");/&\
      wrapMethod(CL.ChannelLock.prototype, "unlock", "ChannelLock");/' "$DBG" || true
  fi
fi

# 3) Wire the runtime fix early in app bootstrap (once)
APP="src/orchestration/app.ts"
if [ -f "$APP" ]; then
  if ! grep -q 'runtime-fixes/role-fix' "$APP"; then
    tmp="$(mktemp)"
    printf 'import "../runtime-fixes/role-fix";\n' > "$tmp"
    cat "$APP" >> "$tmp"
    mv "$tmp" "$APP"
  fi
else
  echo "WARN: $APP not found—adjust path if your entrypoint differs." >&2
fi

echo "✅ role-fix patched and lock tracing expanded."
