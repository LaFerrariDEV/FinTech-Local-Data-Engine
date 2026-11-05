import type { RecordBatch, Table } from "apache-arrow";

/**
 * Minimal runtime-agnostic surface of DuckDB used by EngineCore. The browser implementation
 * wraps @duckdb/duckdb-wasm's AsyncDuckDB (which itself runs in a nested worker); the Node
 * implementation (tests) wraps the blocking bindings. All heavy logic lives in EngineCore so
 * it is exercised by the same integration tests in both environments.
 */
export interface DuckDriver {
  readonly bundle: string;
  version(): Promise<string>;
  query(sql: string): Promise<Table>;
  /** Streams record batches; iteration can be stopped early. */
  stream(sql: string): Promise<AsyncIterable<RecordBatch>>;
  /** Cancels the currently streaming query, if any. */
  cancel(): Promise<boolean>;
  registerBuffer(name: string, bytes: Uint8Array): Promise<void>;
  /** Registers a browser File/Blob without copying it into WASM memory (falls back to a copy). */
  registerBlob(name: string, blob: Blob): Promise<void>;
  dropFile(name: string): Promise<void>;
  copyFileToBuffer(name: string): Promise<Uint8Array>;
  insertArrowTable(table: Table, options: { name: string; create: boolean }): Promise<void>;
  /** Flushes persistent file handles to durable storage (no-op for in-memory databases). */
  flush?(): Promise<void>;
  /** Returns the WASM heap size if the runtime exposes it. */
  heapBytes(): Promise<number | null>;
  close(): Promise<void>;
}

export class EngineError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
