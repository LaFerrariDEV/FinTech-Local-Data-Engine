import * as duckdb from "@duckdb/duckdb-wasm";
import { tableToIPC, type RecordBatch, type Table } from "apache-arrow";
import type { DuckDriver } from "./driver";
import { errorMessage } from "./driver";

/** Database file inside the Origin Private File System (plus DuckDB's write-ahead log). */
export const OPFS_DB_FILE = "quantagent.duckdb";
const INSTANTIATE_TIMEOUT_MS = 60_000;

/**
 * Registers OPFS handles for the database and its WAL before opening.
 *
 * DuckDB-WASM's built-in "opfs://" open path only registers files that are already non-empty,
 * so a brand-new database silently lives in an in-memory buffer and is never persisted. Passing
 * our own FileSystemFileHandles with the FS-access protocol registers them unconditionally. A
 * previous tab/page may still hold the exclusive sync-access lock for a moment after a reload,
 * so lock conflicts are retried briefly.
 */
async function registerOpfsDatabase(db: duckdb.AsyncDuckDB): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (const name of [OPFS_DB_FILE, `${OPFS_DB_FILE}.wal`]) {
    const handle = await root.getFileHandle(name, { create: true });
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await db.registerFileHandle(name, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (lastError) {
      throw new Error(`The persistent database is locked by another QuantAgent tab (${errorMessage(lastError)})`);
    }
  }
}

async function assertReachable(url: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD", cache: "no-cache" });
  } catch (error) {
    throw new Error(`Could not reach the DuckDB runtime at ${url}: ${errorMessage(error)}`);
  }
  if (!res.ok) {
    throw new Error(`DuckDB runtime asset ${url.split("/").pop()} is unavailable (HTTP ${res.status}). Run "npm install" (or "node scripts/copy-duckdb-assets.mjs") to restore public/duckdb.`);
  }
}

export interface BrowserDriverResult {
  driver: DuckDriver;
  persistence: "memory" | "opfs";
  persistenceError: string | null;
}

/**
 * Boots DuckDB-WASM from same-origin assets. DuckDB executes inside its own nested worker
 * (spawned from this engine worker), so neither the UI thread nor the engine worker's message
 * loop is blocked while queries run — which is also what makes cancellation possible.
 */
export async function createBrowserDriver(assetBaseUrl: string, persist: boolean): Promise<BrowserDriverResult> {
  const base = assetBaseUrl.replace(/\/$/, "");
  const bundles: duckdb.DuckDBBundles = {
    mvp: { mainModule: `${base}/duckdb-mvp.wasm`, mainWorker: `${base}/duckdb-browser-mvp.worker.js` },
    eh: { mainModule: `${base}/duckdb-eh.wasm`, mainWorker: `${base}/duckdb-browser-eh.worker.js` },
  };
  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) throw new Error("No DuckDB worker script available for this browser");
  // DuckDB's instantiate() can hang instead of rejecting when the WASM binary is missing, so
  // verify the runtime assets up front and fail fast with an actionable message.
  await Promise.all([assertReachable(bundle.mainModule), assertReachable(bundle.mainWorker)]);
  const worker = new Worker(bundle.mainWorker);
  const workerFailure = new Promise<never>((_, reject) => {
    worker.addEventListener("error", (event) => reject(new Error(`DuckDB worker failed to start: ${event.message || "script error"}`)), { once: true });
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const instantiateTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DuckDB did not finish instantiating within ${INSTANTIATE_TIMEOUT_MS / 1000}s`)), INSTANTIATE_TIMEOUT_MS);
  });
  try {
    await Promise.race([db.instantiate(bundle.mainModule, bundle.pthreadWorker), workerFailure, instantiateTimeout]);
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const queryConfig = { castBigIntToDouble: true, castDecimalToDouble: true };
  let persistence: "memory" | "opfs" = "memory";
  let persistenceError: string | null = null;
  if (persist) {
    try {
      if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") {
        throw new Error("The Origin Private File System is not available in this browser");
      }
      await registerOpfsDatabase(db);
      await db.open({ path: OPFS_DB_FILE, accessMode: duckdb.DuckDBAccessMode.READ_WRITE, useDirectIO: true, query: queryConfig });
      persistence = "opfs";
    } catch (error) {
      persistenceError = errorMessage(error);
      await db.open({ query: queryConfig });
    }
  } else {
    await db.open({ query: queryConfig });
  }
  const conn = await db.connect();
  const bundleName = bundle.mainModule.includes("-eh") ? "eh" : bundle.mainModule.includes("-coi") ? "coi" : "mvp";

  const driver: DuckDriver = {
    bundle: bundleName,
    version: () => db.getVersion(),
    async query(sql: string) {
      return (await conn.query(sql)) as unknown as Table;
    },
    async stream(sql: string) {
      const reader = await conn.send(sql, true);
      return reader as unknown as AsyncIterable<RecordBatch>;
    },
    cancel: () => conn.cancelSent(),
    async registerBuffer(name: string, bytes: Uint8Array) {
      await db.registerFileBuffer(name, bytes);
    },
    async registerBlob(name: string, blob: Blob) {
      try {
        // Zero-copy: DuckDB's worker reads slices on demand with FileReaderSync.
        await db.registerFileHandle(name, blob, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      } catch {
        await db.registerFileBuffer(name, new Uint8Array(await blob.arrayBuffer()));
      }
    },
    async dropFile(name: string) {
      await db.dropFile(name);
    },
    copyFileToBuffer: (name: string) => db.copyFileToBuffer(name),
    async insertArrowTable(table: Table, options: { name: string; create: boolean }) {
      await conn.insertArrowFromIPCStream(tableToIPC(table, "stream"), { name: options.name, create: options.create });
    },
    async heapBytes() {
      return null;
    },
    async flush() {
      if (persistence === "opfs") await db.flushFiles();
    },
    async close() {
      await conn.close().catch(() => undefined);
      await db.terminate().catch(() => undefined);
    },
  };
  return { driver, persistence, persistenceError };
}
