import { DataType, type Table, type Vector } from "apache-arrow";
import type { ColumnKind, ResultColumn } from "../quant/types";

/**
 * Arrow -> transferable columnar conversion. Numeric and temporal columns become Float64Array
 * (NaN for NULL, epoch milliseconds for temporal types) so they can be transferred zero-copy to
 * the UI thread. Everything else becomes a plain array of strings/booleans.
 */

export function columnKind(type: DataType): ColumnKind {
  if (DataType.isFloat(type) || DataType.isInt(type) || DataType.isDecimal(type)) return "number";
  if (DataType.isTimestamp(type)) return "timestamp";
  if (DataType.isDate(type)) return "date";
  if (DataType.isBool(type)) return "boolean";
  if (DataType.isUtf8(type) || DataType.isLargeUtf8(type) || DataType.isDictionary(type)) return "string";
  return "other";
}

export function toNumber(value: unknown): number {
  if (value == null) return Number.NaN;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value as string);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function vectorToFloat64(vector: Vector | null | undefined, length: number): Float64Array {
  const out = new Float64Array(length);
  if (!vector) {
    out.fill(Number.NaN);
    return out;
  }
  const type = vector.type;
  if (DataType.isFloat(type) && vector.nullCount === 0) {
    let offset = 0;
    for (const chunk of vector.data) {
      const values = chunk.values as Float64Array | Float32Array;
      const view = values.subarray(chunk.offset, chunk.offset + chunk.length);
      out.set(view, offset);
      offset += chunk.length;
    }
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = toNumber(vector.get(i));
  return out;
}

export function stringifyValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Array.from(value.subarray(0, 64), (b) => b.toString(16).padStart(2, "0")).join("")}${value.length > 64 ? "…" : ""}`;
  if (typeof value === "object") {
    const maybeJson = value as { toJSON?: () => unknown };
    const plain = typeof maybeJson.toJSON === "function" ? maybeJson.toJSON() : value;
    return JSON.stringify(plain, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
}

export function tableToColumns(table: Table, maxRows = Number.POSITIVE_INFINITY): { columns: ResultColumn[]; rowCount: number } {
  const rowCount = Math.min(table.numRows, maxRows);
  const sliced = rowCount < table.numRows ? table.slice(0, rowCount) : table;
  const columns: ResultColumn[] = sliced.schema.fields.map((field, idx) => {
    const vector = sliced.getChildAt(idx);
    const kind = columnKind(field.type);
    const base = { name: field.name, type: String(field.type), kind };
    if (kind === "number" || kind === "timestamp" || kind === "date") {
      return { ...base, numbers: vectorToFloat64(vector, rowCount) };
    }
    const values: (string | boolean | null)[] = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      const v = vector?.get(i);
      values[i] = kind === "boolean" ? (v == null ? null : Boolean(v)) : stringifyValue(v);
    }
    return { ...base, values };
  });
  return { columns, rowCount };
}

/** Structural view of a record batch / table: avoids instanceof checks across Arrow copies. */
interface ColumnarLike {
  numRows: number;
  schema: { fields: { name: string; type: DataType }[] };
  getChildAt(index: number): Vector | null;
}

/**
 * Concatenates streamed record batches into transferable columns, reading at most `maxRows`.
 * Works purely through the structural Arrow API so batches produced by a different Arrow
 * module instance (e.g. DuckDB's bundled copy) are handled safely.
 */
export function batchesToColumns(batches: ColumnarLike[], maxRows: number): { columns: ResultColumn[]; rowCount: number } {
  const total = Math.min(maxRows, batches.reduce((a, b) => a + b.numRows, 0));
  const fields = batches[0]?.schema.fields ?? [];
  const columns: ResultColumn[] = fields.map((field) => {
    const kind = columnKind(field.type);
    const base = { name: field.name, type: String(field.type), kind };
    if (kind === "number" || kind === "timestamp" || kind === "date") return { ...base, numbers: new Float64Array(total) };
    return { ...base, values: new Array<string | boolean | null>(total) };
  });
  let offset = 0;
  for (const batch of batches) {
    if (offset >= total) break;
    const take = Math.min(batch.numRows, total - offset);
    columns.forEach((col, c) => {
      const vector = batch.getChildAt(c);
      if (col.numbers) {
        col.numbers.set(vectorToFloat64(vector, batch.numRows).subarray(0, take), offset);
      } else if (col.values) {
        for (let i = 0; i < take; i++) {
          const v = vector?.get(i);
          col.values[offset + i] = col.kind === "boolean" ? (v == null ? null : Boolean(v)) : stringifyValue(v);
        }
      }
    });
    offset += take;
  }
  return { columns, rowCount: total };
}

/** Converts small results to plain row objects (used for metadata queries and agent tools). */
export function tableToRows(table: Table, maxRows = 10_000): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const limit = Math.min(table.numRows, maxRows);
  const fields = table.schema.fields;
  const vectors = fields.map((_, i) => table.getChildAt(i));
  for (let r = 0; r < limit; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < fields.length; c++) {
      const kind = columnKind(fields[c].type);
      const v = vectors[c]?.get(r);
      if (v == null) row[fields[c].name] = null;
      else if (kind === "number") row[fields[c].name] = toNumber(v);
      else if (kind === "timestamp" || kind === "date") row[fields[c].name] = toNumber(v);
      else if (kind === "boolean") row[fields[c].name] = Boolean(v);
      else if (kind === "string") row[fields[c].name] = String(v);
      else row[fields[c].name] = stringifyValue(v);
    }
    rows.push(row);
  }
  return rows;
}

/** Collects ArrayBuffers backing typed arrays inside a message so they can be transferred. */
export function collectTransferables(value: unknown, out: Set<ArrayBuffer> = new Set(), depth = 0): Set<ArrayBuffer> {
  if (value == null || depth > 8) return out;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    // Only transfer buffers fully owned by this view; shared/sliced buffers are cloned instead.
    if (buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === buffer.byteLength) out.add(buffer);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object") collectTransferables(item, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== null && typeof item === "object") collectTransferables(item, out, depth + 1);
    }
  }
  return out;
}
