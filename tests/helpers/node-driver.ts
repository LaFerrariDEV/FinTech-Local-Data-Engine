import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { tableToIPC, type RecordBatch, type Table } from "apache-arrow";
import type { DuckDriver } from "../../src/lib/engine/driver";
import { EngineCore } from "../../src/lib/engine/core";

/**
 * DuckDriver backed by DuckDB-WASM's blocking Node bindings. It runs the exact same WASM
 * binary as the browser build, so integration tests validate the real SQL dialect, CSV
 * reader and Arrow conversion used in production.
 */

const require = createRequire(import.meta.url);
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as typeof import("@duckdb/duckdb-wasm/blocking");

const DIST = path.resolve(process.cwd(), "node_modules/@duckdb/duckdb-wasm/dist");

export async function createNodeDriver(): Promise<DuckDriver> {
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: path.join(DIST, "duckdb-mvp.wasm"), mainWorker: path.join(DIST, "duckdb-node-mvp.worker.cjs") },
      eh: { mainModule: path.join(DIST, "duckdb-eh.wasm"), mainWorker: path.join(DIST, "duckdb-node-eh.worker.cjs") },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
  const conn = db.connect();
  return {
    bundle: "node-blocking",
    async version() {
      return db.getVersion();
    },
    async query(sql: string) {
      return conn.query(sql) as unknown as Table;
    },
    async stream(sql: string) {
      const reader = await conn.send(sql);
      async function* iterate(): AsyncGenerator<RecordBatch> {
        for (const batch of reader as unknown as Iterable<RecordBatch>) yield batch;
      }
      return iterate();
    },
    async cancel() {
      return conn.cancelSent();
    },
    async registerBuffer(name: string, bytes: Uint8Array) {
      db.registerFileBuffer(name, bytes);
    },
    async registerBlob(name: string, blob: Blob) {
      db.registerFileBuffer(name, new Uint8Array(await blob.arrayBuffer()));
    },
    async dropFile(name: string) {
      db.dropFile(name);
      // The Node runtime maps COPY ... TO targets onto the real filesystem.
      if (name.startsWith("__qa_export_")) fs.rmSync(path.resolve(process.cwd(), name), { force: true });
    },
    async copyFileToBuffer(name: string) {
      return db.copyFileToBuffer(name);
    },
    async insertArrowTable(table: Table, options: { name: string; create: boolean }) {
      // IPC bytes avoid the dual-package hazard between DuckDB's CJS Arrow and the ESM copy.
      conn.insertArrowFromIPCStream(tableToIPC(table, "stream"), { name: options.name, create: options.create });
    },
    async heapBytes() {
      return null;
    },
    async close() {
      conn.close();
      db.reset();
    },
  };
}

export async function createNodeEngine(): Promise<EngineCore> {
  const engine = new EngineCore(await createNodeDriver());
  await engine.init();
  return engine;
}
