import {
  Bool,
  Float64,
  Table,
  TimestampMillisecond,
  Utf8,
  vectorFromArray,
  type DataType,
  type Vector,
} from "apache-arrow";
import { parquetMetadata, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { parquetWriteBuffer } from "hyparquet-writer";
import type { ResultColumn } from "../quant/types";
import { EngineError, errorMessage } from "./driver";

/**
 * Pure-JS Parquet support. DuckDB-WASM ships Parquet as a downloadable extension; to stay fully
 * local-first (no network access at runtime) Parquet files are decoded with hyparquet inside the
 * engine worker and streamed into DuckDB as Arrow batches, one row-group window at a time.
 */

type ColumnType = "number" | "timestamp" | "boolean" | "string";

const BATCH_ROWS = 131_072;

function classify(value: unknown): ColumnType | null {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (value instanceof Date) return "timestamp";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function toText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === "object") return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

function buildVector(values: unknown[], type: ColumnType): Vector {
  switch (type) {
    case "number":
      return vectorFromArray(values.map(toNumber), new Float64() as DataType);
    case "timestamp":
      return vectorFromArray(
        values.map((v) => (v == null ? null : v instanceof Date ? v.getTime() : toNumber(v))),
        new TimestampMillisecond() as DataType,
      );
    case "boolean":
      return vectorFromArray(values.map((v) => (v == null ? null : Boolean(v))), new Bool() as DataType);
    case "string":
      return vectorFromArray(values.map(toText), new Utf8() as DataType);
  }
}

export interface ParquetIngestProgress {
  rowsRead: number;
  totalRows: number;
}

/**
 * Decodes a Parquet file and hands Arrow tables of at most BATCH_ROWS rows to `sink`.
 * Returns the number of rows read. Column types are fixed from the first non-null value seen
 * in the file so every batch has an identical schema.
 */
export async function readParquetBatches(
  buffer: ArrayBuffer,
  sink: (table: Table, first: boolean) => Promise<void>,
  onProgress?: (p: ParquetIngestProgress) => void,
): Promise<number> {
  let metadata;
  try {
    metadata = parquetMetadata(buffer);
  } catch (error) {
    throw new EngineError("MALFORMED_PARQUET", `Not a valid Parquet file: ${errorMessage(error)}`);
  }
  const totalRows = Number(metadata.num_rows);
  const schema = parquetSchema(metadata);
  const names = schema.children.map((c) => c.element.name);
  if (names.length === 0) throw new EngineError("MALFORMED_PARQUET", "Parquet file has no columns");
  const types: (ColumnType | null)[] = names.map(() => null);
  let rowsRead = 0;
  let first = true;
  for (let start = 0; start < totalRows || (totalRows === 0 && first); start += BATCH_ROWS) {
    const end = Math.min(totalRows, start + BATCH_ROWS);
    let rows: unknown[][] = [];
    if (end > start) {
      try {
        await parquetRead({
          file: buffer,
          metadata,
          compressors,
          rowStart: start,
          rowEnd: end,
          columns: names,
          rowFormat: "array",
          onComplete: (r: unknown[][]) => {
            rows = r;
          },
        });
      } catch (error) {
        throw new EngineError("MALFORMED_PARQUET", `Failed to decode Parquet rows ${start}-${end}: ${errorMessage(error)}`);
      }
    }
    const columns: Record<string, Vector> = {};
    names.forEach((name, c) => {
      const values = new Array<unknown>(rows.length);
      for (let r = 0; r < rows.length; r++) values[r] = rows[r][c];
      if (types[c] == null) {
        for (const v of values) {
          const t = classify(v);
          if (t) {
            types[c] = t;
            break;
          }
        }
      }
      // A column that is entirely NULL in the first batch is fixed as VARCHAR so that every
      // batch appended to the DuckDB table shares one schema.
      if (types[c] == null) types[c] = "string";
      columns[name] = buildVector(values, types[c]);
    });
    const table = new Table(columns);
    await sink(table, first);
    first = false;
    rowsRead += rows.length;
    onProgress?.({ rowsRead, totalRows });
    if (totalRows === 0) break;
  }
  return rowsRead;
}

/** Encodes columnar query results as a Parquet file (snappy-free, plain encoding). */
export function writeParquet(columns: ResultColumn[], rowCount: number): Uint8Array {
  const columnData = columns.map((col) => {
    if (col.kind === "number" && col.numbers) {
      const data = new Array<number | null>(rowCount);
      for (let i = 0; i < rowCount; i++) data[i] = Number.isNaN(col.numbers[i]) ? null : col.numbers[i];
      return { name: col.name, data, type: "DOUBLE" as const };
    }
    if ((col.kind === "timestamp" || col.kind === "date") && col.numbers) {
      const data = new Array<Date | null>(rowCount);
      for (let i = 0; i < rowCount; i++) data[i] = Number.isNaN(col.numbers[i]) ? null : new Date(col.numbers[i]);
      return { name: col.name, data, type: "TIMESTAMP" as const };
    }
    if (col.kind === "boolean" && col.values) {
      return { name: col.name, data: col.values.map((v) => (v == null ? null : Boolean(v))), type: "BOOLEAN" as const };
    }
    return { name: col.name, data: (col.values ?? []).map((v) => (v == null ? null : String(v))), type: "STRING" as const };
  });
  const buffer = parquetWriteBuffer({ columnData });
  return new Uint8Array(buffer);
}
