/**
 * PortableFS
 * A tiny wrapper around filesystem operations that works in both Node and Bun.
 * All platform-specific calls are centralized here.
 */
export class PortableFS {
  /**
   * mkdir -p (recursively create parent directories)
   */
  static async mkdirp(dir: string): Promise<void> {
    // Use Node's fs/promises (available in Bun as well)
    const fs = await import("fs/promises");
    await fs.mkdir(dir || ".", { recursive: true });
  }

  /**
   * Write a UTF-8 text file (overwrites any existing content)
   */
  static async writeFile(file: string, data: string): Promise<void> {
    // Prefer Bun.write if available, otherwise fallback to Node's fs/promises
    const bun = (globalThis as any).Bun;
    if (bun?.write) {
      await bun.write(file, data);
      return;
    }
    const fs = await import("fs/promises");
    await fs.writeFile(file, data, { encoding: "utf8" });
  }

  /**
   * Best-effort file existence check (not strictly needed for writing).
   */
  static async exists(file: string): Promise<boolean> {
    try {
      const fs = await import("fs/promises");
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }
}
