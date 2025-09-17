// src/idsl/hash.ts
// Small, deterministic string hash (FNV-1a 64-bit)

export function fnv1a64(input: string): string {
  let hi = 0xcbf29ce4, lo = 0x84222325; // 64-bit basis split
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    hi ^= c >>> 24;
    lo ^= c & 0xff;
    // multiply by FNV prime 1099511628211 (split)
    const primeHi = 0x000001b3;
    const primeLo = 0x00000000 + 0x100000000 - 0x4f; // approx by shifting
    // simple 64-bit mul via JS 32-bit ops (not perfect but stable enough)
    const a = (lo >>> 16) * 0x1b3 + (lo & 0xffff) * 0x1b3;
    const b = (hi >>> 16) * 0x1b3 + (hi & 0xffff) * 0x1b3 + (a >>> 16);
    hi = b & 0xffffffff;
    lo = (a & 0xffff) << 16;
  }
  // fallback: JS big-int stable hex
  let h = 1469598103934665603n; // FNV offset
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h *= 1099511628211n;
    h &= (1n << 64n) - 1n;
  }
  const s = h.toString(16).padStart(16, "0");
  return s;
}
