import * as path from "path";
import { PortableFS } from "./portable-fs";
import { sanitizeContent } from "../utils/sanitize-content";

/**
 * FileWriter
 * High-level helper to write content to disk, creating parent directories
 * and normalizing filenames/content in a model-friendly way.
 */
export type WriteResult = { path: string; bytes: number };

export interface Writer {
  write(filename: string, content: string): Promise<WriteResult>;
}

export class FileWriter implements Writer {
  /**
   * Normalize filenames:
   * - Trim whitespace
   * - If not starting with "/" or ".", prefix "./" (relative path)
   * (Your TagParser already tries to do this; this is a final safeguard.)
   */
  normalizeFilename(name: string): string {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "./unnamed.txt";
    if (trimmed.startsWith("/") || trimmed.startsWith(".")) return trimmed;
    return "./" + trimmed;
  }

  /**
   * Write content to file, ensuring parent directory exists.
   * Appends a trailing newline if one isn't present.
   */
  async write(filename: string, content: string): Promise<WriteResult> {
    const target = this.normalizeFilename(filename);
    const dir = path.dirname(target);

    // Normalize content and ensure trailing newline
    let data = sanitizeContent(content);
    if (!data.endsWith("\n")) data += "\n";

    await PortableFS.mkdirp(dir);
    await PortableFS.writeFile(target, data);

    // Use TextEncoder for portable byte-length
    const bytes = new TextEncoder().encode(data).length;
    return { path: target, bytes };
  }
}
