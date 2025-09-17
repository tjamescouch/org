// src/memory/memory-persistence.ts
import { promises as fs } from "fs";
import * as path from "path";
import { R } from "../runtime/runtime";

/**
 * Generic persistence for an agent's memory state.
 *
 * Storage layout (per agent):
 *   <cwd>/.orgmemories/memory-<id>.txt
 *
 * Semantics:
 * - Atomic overwrite on save (tmp + rename).
 * - JSON payload (optionally pretty), newline preserved if pretty.
 *
 * Note: Keeping the original (misspelled) class/interface names for compatibility.
 */
export interface IMemoryPersisitence<T = unknown> {
  /** Persist the entire state snapshot for the given agent (atomic). */
  save(id: string, state: T): Promise<void>;

  /** Load the last saved state for the given agent (or null if none). */
  load(id: string): Promise<T | null>;
}

export class MemoryPersisitence<T = unknown> implements IMemoryPersisitence<T> {
  /** Directory where memory files live (defaults to "<cwd>/.orgmemories"). */
  private readonly dirPath: string;
  private readonly pretty: boolean;
  private readonly atomic: boolean;
  private readonly defaultState: T | null;

  constructor(opts?: {
    /**
     * Target directory for memory files (defaults to "<cwd>/.orgmemories").
     * For backwards compatibility, if `filePath` is provided it is treated as a directory.
     */
    /** Pretty-print JSON with trailing newline (defaults to false). */
    pretty?: boolean;
    /** Use tmp+rename atomic writes (defaults to true). */
    atomic?: boolean;
    /** Fallback value when a file doesn't exist or is empty (defaults to null). */
    defaultState?: T | null;
  }) {
    const base = path.join(R.cwd(), ".orgmemories");
    this.dirPath = path.resolve(base);
    this.pretty = opts?.pretty ?? false;
    this.atomic = opts?.atomic ?? true;
    this.defaultState = opts?.defaultState ?? null;
  }

  public async save(id: string, state: T): Promise<void> {
    // Fail fast if state is not JSON-serializable.
    const payload = this.serialize(state);

    // Ensure target directory exists.
    await fs.mkdir(this.dirPath, { recursive: true });

    const target = this.pathFor(id);

    if (!this.atomic) {
      await fs.writeFile(target, payload, "utf8");
      return;
    }

    // Atomic write via tmp + rename.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, target);
  }

  public async load(id: string): Promise<T | null> {
    const target = this.pathFor(id);
    try {
      const txt = await fs.readFile(target, "utf8");
      const trimmed = txt.trim();
      if (trimmed.length === 0) return this.defaultState;
      return JSON.parse(trimmed) as T;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") return this.defaultState; // no file yet
      throw new Error(`MemoryPersisitence: failed to load ${target}: ${(err as Error).message}`);
    }
  }

  // ---------------- internal helpers ----------------

  /** Compute the on-disk path for an agent id, enforcing a safe filename. */
  private pathFor(id: string): string {
    const safe = this.sanitizeId(id);
    return path.join(this.dirPath, `memory-${safe}.txt`);
  }

  /** Replace disallowed filename chars; keep readable, deterministic ids. */
  private sanitizeId(id: string): string {
    const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return cleaned.length > 0 ? cleaned : "unknown";
  }

  /** Serialize state to JSON (optionally pretty) and ensure newline iff pretty. */
  private serialize(state: T): string {
    try {
      return this.pretty
        ? JSON.stringify(state, null, 2) + "\n"
        : JSON.stringify(state);
    } catch (err) {
      throw new Error(
        `MemoryPersisitence: state is not JSON-serializable: ${(err as Error).message}`,
      );
    }
  }
}
