// src/memory/memory-persistence.ts
import { promises as fs } from "fs";
import * as path from "path";
import { R } from "../runtime/runtime";

/**
 * Generic persistence for an agent's memory state.
 * - Default file: "<cwd>/.orgmemories"
 * - Atomic write: write to "<file>.<ts>.tmp" then rename()
 * - Type-safe generics: T is the serialized state shape
 *
 * Note: Keeping the original (misspelled) names for compatibility.
 */
export interface IMemoryPersisitence<T = unknown> {
  /** Persist the entire state snapshot to disk (atomic). */
  save(state: T): Promise<void>;

  /** Load the last saved state (or null if none). */
  load(): Promise<T | null>;
}

export class MemoryPersisitence<T = unknown> implements IMemoryPersisitence<T> {
  private readonly filePath: string;
  private readonly pretty: boolean;
  private readonly atomic: boolean;
  private readonly defaultState: T | null;

  constructor(opts?: {
    /** Target path for the JSON file (defaults to "<cwd>/.orgmemories"). */
    filePath?: string;
    /** Pretty-print JSON with trailing newline (defaults to false). */
    pretty?: boolean;
    /** Use tmp+rename atomic writes (defaults to true). */
    atomic?: boolean;
    /** Fallback value when the file doesn't exist or is empty (defaults to null). */
    defaultState?: T | null;
  }) {
    this.filePath = path.resolve(opts?.filePath ?? path.join(R.cwd(), ".orgmemories"));
    this.pretty = opts?.pretty ?? false;
    this.atomic = opts?.atomic ?? true;
    this.defaultState = opts?.defaultState ?? null;
  }

  public async save(state: T): Promise<void> {
    Logger.info("Persisting modelstate");
    // Fail fast if state is not JSON-serializable.
    let payload: string;
    try {
      payload = this.pretty ? JSON.stringify(state, null, 2) + "\n" : JSON.stringify(state);
    } catch (err) {
      throw new Error(`MemoryPersisitence: state is not JSON-serializable: ${(err as Error).message}`);
    }

    // Ensure parent directory exists (in case a custom path was provided).
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    if (!this.atomic) {
      await fs.writeFile(this.filePath, payload, "utf8");
      return;
    }

    // Atomic write via tmp + rename.
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  public async load(): Promise<T | null> {
    try {
      const txt = await fs.readFile(this.filePath, "utf8");
      const trimmed = txt.trim();
      if (trimmed.length === 0) return this.defaultState;
      return JSON.parse(trimmed) as T;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") return this.defaultState; // no file yet
      throw new Error(`MemoryPersisitence: failed to load ${this.filePath}: ${(err as Error).message}`);
    }
  }
}
