import type { RecordBatch, Table } from "apache-arrow";
import {
  computeMetrics,
  downsampleCurves,
  monthlyReturns,
  returnHistogram,
  sanitizeTargets,
  simulate,
  strategyTargets,
  validateStrategy,
} from "../quant/backtest";
import { assembleIndicators } from "../quant/indicators";
import {
  buildBarsCte,
  buildBarsQuery,
  buildNormalizeSql,
  resolveTimeframe,
  validateIndicator,
} from "../quant/ohlcv-sql";
import { detectMapping, isNumericType, validateMapping } from "../quant/schema-detect";
import { assertInt, maskLiterals, quoteIdent, quoteLiteral, splitStatements, toTableName } from "../quant/sql";
import { assertReadOnlySql } from "../quant/sql-guard";
import type {
  BacktestRequest,
  BacktestResult,
  BarsRequest,
  BarsResult,
  CatalogTable,
  ColumnMapping,
  DatasetFormat,
  DatasetInfo,
  EngineStats,
  NumericRange,
  QualityIssue,
  QualityReport,
  QueryResult,
  RejectedRow,
  SourceColumn,
  Timeframe,
} from "../quant/types";
import { batchesToColumns, tableToColumns, tableToRows, vectorToFloat64 } from "./arrow-utils";
import { EngineError, errorMessage, type DuckDriver } from "./driver";
import { readParquetBatches, writeParquet } from "./parquet";

/** Longest single CSV line accepted (DuckDB default is 2 MB). */
export const MAX_LINE_SIZE = 64 * 1024 * 1024;
/** DuckDB requires buffer_size >= max_line_size; without it the reader over-allocates (16x). */
export const CSV_BUFFER_SIZE = 2 * MAX_LINE_SIZE;
const REGISTRY = "__qa_datasets";
const DEFAULT_MAX_BARS = 20_000;
const DEFAULT_MAX_ROWS = 10_000;

export type ProgressFn = (phase: string, detail?: Record<string, unknown>) => void;

export interface IngestSource {
  fileName: string;
  size: number;
  blob?: Blob;
  bytes?: Uint8Array;
}

export interface IngestOptions {
  /** Quarantine malformed CSV rows into a rejects report instead of failing the import. */
  lenient?: boolean;
  /** Override the generated table name. */
  tableName?: string;
  format?: "csv" | "parquet";
}

export interface SampleOptions {
  kind: "daily" | "intraday";
  bars?: number;
  seed?: number;
  tableName?: string;
}

export interface ExportRequest {
  sql?: string;
  table?: string;
  format: "csv" | "parquet";
}

export interface ExportResult {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  rows: number;
}

/** Serializes access to the single DuckDB connection. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const READ_ONLY_LEADING = new Set(["SELECT", "WITH", "FROM", "DESCRIBE", "SUMMARIZE", "SHOW", "EXPLAIN", "VALUES", "TABLE", "PRAGMA"]);

function firstKeyword(statement: string): string {
  return /^[\s(]*([A-Za-z_]+)/.exec(maskLiterals(statement))?.[1]?.toUpperCase() ?? "";
}

function parseCsvError(message: string): { line: number | null; hint: string } {
  const line = /Line:\s*(\d+)/i.exec(message)?.[1];
  return { line: line ? Number(line) : null, hint: message.split("\n").slice(0, 6).join("\n") };
}

/** Guesses the delimiter from the header/first lines, ignoring quoted sections. */
export function guessDelimiter(head: string): string {
  const lines = head.split(/\r?\n/).slice(0, 20).filter((l) => l.length > 0);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((line) => {
      let inQuote = false;
      let count = 0;
      for (const ch of line) {
        if (ch === '"') inQuote = !inQuote;
        else if (ch === d && !inQuote) count++;
      }
      return count;
    });
    if (counts.length === 0 || counts[0] === 0) continue;
    // Prefer delimiters whose count is consistent with the header line.
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function formatFromName(name: string): "csv" | "parquet" | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["csv", "tsv", "txt", "psv", "dat"].includes(ext)) return "csv";
  if (["parquet", "pq", "parq"].includes(ext)) return "parquet";
  return null;
}

export class EngineCore {
  private readonly serial = new Serial();
  private readonly datasets = new Map<string, DatasetInfo>();

  constructor(private readonly driver: DuckDriver) {}

  get bundle(): string {
    return this.driver.bundle;
  }

  async init(): Promise<DatasetInfo[]> {
    return this.serial.run(async () => {
      for (const stmt of ["SET autoload_known_extensions = false", "SET autoinstall_known_extensions = false"]) {
        try {
          await this.driver.query(stmt);
        } catch {
          // Older builds may not expose these settings; extension loading is then simply unused.
        }
      }
      await this.driver.query(`CREATE TABLE IF NOT EXISTS ${REGISTRY} (name VARCHAR PRIMARY KEY, info VARCHAR)`);
      const rows = tableToRows(await this.driver.query(`SELECT name, info FROM ${REGISTRY}`));
      const existing = new Set(
        tableToRows(await this.driver.query("SELECT table_name FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views() WHERE NOT internal")).map(
          (r) => String(r.table_name),
        ),
      );
      this.datasets.clear();
      for (const row of rows) {
        try {
          const info = JSON.parse(String(row.info)) as DatasetInfo;
          if (existing.has(info.name)) this.datasets.set(info.name, info);
          else await this.driver.query(`DELETE FROM ${REGISTRY} WHERE name = ${quoteLiteral(String(row.name))}`);
        } catch {
          await this.driver.query(`DELETE FROM ${REGISTRY} WHERE name = ${quoteLiteral(String(row.name))}`);
        }
      }
      return this.listDatasets();
    });
  }

  version(): Promise<string> {
    return this.driver.version();
  }

  listDatasets(): DatasetInfo[] {
    return Array.from(this.datasets.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getDataset(name: string): DatasetInfo {
    const ds = this.datasets.get(name);
    if (!ds) throw new EngineError("UNKNOWN_DATASET", `Dataset "${name}" is not loaded`);
    return ds;
  }

  private takenNames(): string[] {
    return Array.from(this.datasets.values()).flatMap((d) => [d.name, d.rawTable]);
  }

  private async saveRegistry(info: DatasetInfo): Promise<void> {
    await this.driver.query(
      `INSERT OR REPLACE INTO ${REGISTRY} VALUES (${quoteLiteral(info.name)}, ${quoteLiteral(JSON.stringify(info))})`,
    );
  }

  // ---------------------------------------------------------------- ingestion

  async ingest(source: IngestSource, options: IngestOptions = {}, progress?: ProgressFn): Promise<DatasetInfo> {
    return this.serial.run(() => this.ingestUnlocked(source, options, progress));
  }

  private async ingestUnlocked(source: IngestSource, options: IngestOptions, progress?: ProgressFn): Promise<DatasetInfo> {
    const started = performance.now();
    if (!source.blob && !source.bytes) throw new EngineError("BAD_REQUEST", "No file contents provided");
    if (source.size === 0) throw new EngineError("EMPTY_FILE", `"${source.fileName}" is empty`);
    const format = options.format ?? formatFromName(source.fileName) ?? (await this.sniffFormat(source));
    const name = options.tableName ? toTableName(options.tableName, this.takenNames()) : toTableName(source.fileName, this.takenNames());
    const rawTable = `${name}_raw`;
    let rejected: { count: number; samples: RejectedRow[] } = { count: 0, samples: [] };
    const warnings: string[] = [];
    progress?.("reading", { fileName: source.fileName, format });
    try {
      if (format === "parquet") {
        await this.loadParquet(source, rawTable, progress);
      } else {
        const result = await this.loadCsv(source, rawTable, Boolean(options.lenient), progress);
        rejected = result.rejected;
        warnings.push(...result.warnings);
      }
      progress?.("normalizing");
      const info = await this.finalizeDataset({
        name,
        rawTable,
        sourceName: source.fileName,
        format,
        sizeBytes: source.size,
        rejected,
        warnings,
        started,
      });
      progress?.("done", { rows: info.rows });
      return info;
    } catch (error) {
      await this.dropQuietly([name, rawTable]);
      if (error instanceof EngineError) throw error;
      throw new EngineError("INGEST_FAILED", `Failed to load "${source.fileName}": ${errorMessage(error)}`);
    }
  }

  private async sniffFormat(source: IngestSource): Promise<"csv" | "parquet"> {
    const head = source.bytes ? source.bytes.subarray(0, 4) : new Uint8Array(await source.blob!.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31 ? "parquet" : "csv";
  }

  private async readHead(source: IngestSource, bytes = 65_536): Promise<string> {
    const slice = source.bytes ? source.bytes.subarray(0, bytes) : new Uint8Array(await source.blob!.slice(0, bytes).arrayBuffer());
    return new TextDecoder().decode(slice);
  }

  private async loadCsv(
    source: IngestSource,
    rawTable: string,
    lenient: boolean,
    progress?: ProgressFn,
  ): Promise<{ rejected: { count: number; samples: RejectedRow[] }; warnings: string[] }> {
    const virtual = `__src_${rawTable}.csv`;
    if (source.bytes) await this.driver.registerBuffer(virtual, source.bytes);
    else await this.driver.registerBlob(virtual, source.blob!);
    const warnings: string[] = [];
    try {
      const head = await this.readHead(source);
      const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
      const file = quoteLiteral(virtual);
      const common = `max_line_size = ${MAX_LINE_SIZE}, buffer_size = ${CSV_BUFFER_SIZE}, header = true`;
      if (lenient) {
        const delim = guessDelimiter(head);
        const rej = `__qa_rej_${rawTable}`;
        const scan = `__qa_rejscan_${rawTable}`;
        progress?.("parsing", { mode: "lenient", delimiter: delim });
        await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(rej)}`);
        await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(scan)}`);
        await this.driver.query(
          `CREATE TABLE ${quoteIdent(rawTable)} AS SELECT * FROM read_csv(${file}, ${common}, delim = ${quoteLiteral(delim)}, ` +
            `store_rejects = true, rejects_table = ${quoteLiteral(rej)}, rejects_scan = ${quoteLiteral(scan)}, sample_size = -1)`,
        );
        const countRow = tableToRows(await this.driver.query(`SELECT count(*) AS n FROM ${quoteIdent(rej)}`))[0];
        const count = Number(countRow?.n ?? 0);
        const samples = tableToRows(
          await this.driver.query(
            `SELECT line, column_name, CAST(error_type AS VARCHAR) AS error_type, error_message, csv_line FROM ${quoteIdent(rej)} ORDER BY line LIMIT 25`,
          ),
        ).map((r) => ({
          line: r.line == null ? null : Number(r.line),
          column: r.column_name == null ? null : String(r.column_name),
          errorType: String(r.error_type ?? "ERROR"),
          message: String(r.error_message ?? ""),
          csvLine: r.csv_line == null ? null : String(r.csv_line).slice(0, 500),
        }));
        await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(rej)}`);
        await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(scan)}`);
        if (count > 0) warnings.push(`${count.toLocaleString()} malformed row(s) were quarantined and not imported.`);
        await this.assertSniffed(rawTable, firstLine);
        return { rejected: { count, samples }, warnings };
      }

      progress?.("parsing", { mode: "strict" });
      const attempts = [`sample_size = 20480`, `sample_size = -1`];
      let lastError: unknown = null;
      for (let i = 0; i < attempts.length; i++) {
        try {
          await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(rawTable)}`);
          await this.driver.query(`CREATE TABLE ${quoteIdent(rawTable)} AS SELECT * FROM read_csv(${file}, ${common}, ${attempts[i]})`);
          if (i > 0) warnings.push("Column types were inferred from a full scan because late rows did not match the sampled types.");
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const message = errorMessage(error);
          // Only conversion errors benefit from a full-file type sniff; structural errors do not.
          if (!/convert|conversion|Could not parse|type/i.test(message)) break;
        }
      }
      if (lastError) {
        const { line, hint } = parseCsvError(errorMessage(lastError));
        throw new EngineError(
          "MALFORMED_CSV",
          `The CSV file could not be parsed strictly${line ? ` (problem near line ${line})` : ""}. ` +
            `Retry with lenient mode to quarantine malformed rows.\n${hint}`,
          { line, lenientAvailable: true },
        );
      }
      await this.assertSniffed(rawTable, firstLine);
      return { rejected: { count: 0, samples: [] }, warnings };
    } finally {
      await this.driver.dropFile(virtual).catch(() => undefined);
    }
  }

  /** Detects the "whole line became one column" failure mode of dialect sniffing. */
  private async assertSniffed(rawTable: string, firstLine: string): Promise<void> {
    const cols = await this.describe(rawTable);
    if (cols.length !== 1) return;
    const name = cols[0].name;
    const delimiters = [",", ";", "\t", "|"].filter((d) => name.includes(d) || firstLine.split(d).length > 2);
    if (delimiters.length > 0) {
      await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(rawTable)}`);
      throw new EngineError(
        "MALFORMED_CSV",
        "The CSV dialect could not be detected consistently — some rows likely have a different number of columns than the header. " +
          "Retry with lenient mode to quarantine malformed rows.",
        { lenientAvailable: true },
      );
    }
  }

  private async loadParquet(source: IngestSource, rawTable: string, progress?: ProgressFn): Promise<void> {
    const buffer = source.bytes
      ? source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength)
      : await source.blob!.arrayBuffer();
    await readParquetBatches(
      buffer as ArrayBuffer,
      async (table, first) => {
        await this.driver.insertArrowTable(table, { name: rawTable, create: first });
      },
      (p) => progress?.("parsing", { rowsRead: p.rowsRead, totalRows: p.totalRows }),
    );
  }

  private async describe(table: string): Promise<SourceColumn[]> {
    const rows = tableToRows(
      await this.driver.query(
        `SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = ${quoteLiteral(table)} ORDER BY column_index`,
      ),
    );
    return rows.map((r) => ({ name: String(r.column_name), type: String(r.data_type) }));
  }

  private async numericRanges(table: string, columns: SourceColumn[]): Promise<Record<string, NumericRange>> {
    const numeric = columns.filter((c) => isNumericType(c.type)).slice(0, 200);
    if (numeric.length === 0) return {};
    const select = numeric
      .map((c, i) => `CAST(min(${quoteIdent(c.name)}) AS DOUBLE) AS mn${i}, CAST(max(${quoteIdent(c.name)}) AS DOUBLE) AS mx${i}`)
      .join(", ");
    const row = tableToRows(await this.driver.query(`SELECT ${select} FROM ${quoteIdent(table)}`))[0] ?? {};
    const out: Record<string, NumericRange> = {};
    numeric.forEach((c, i) => {
      out[c.name] = { min: Number(row[`mn${i}`]), max: Number(row[`mx${i}`]) };
    });
    return out;
  }

  private async finalizeDataset(args: {
    name: string;
    rawTable: string;
    sourceName: string;
    format: DatasetFormat;
    sizeBytes: number;
    rejected: { count: number; samples: RejectedRow[] };
    warnings: string[];
    started: number;
    mapping?: ColumnMapping;
  }): Promise<DatasetInfo> {
    const columns = await this.describe(args.rawTable);
    if (columns.length === 0) throw new EngineError("INGEST_FAILED", "The file produced no columns");
    const rawRows = Number(tableToRows(await this.driver.query(`SELECT count(*) AS n FROM ${quoteIdent(args.rawTable)}`))[0]?.n ?? 0);
    let mapping: ColumnMapping;
    let chartable: boolean;
    const warnings = [...args.warnings];
    if (args.mapping) {
      const errors = validateMapping(args.mapping, columns);
      if (errors.length) throw new EngineError("BAD_MAPPING", errors.join(" "));
      mapping = args.mapping;
      chartable = true;
    } else {
      const ranges = await this.numericRanges(args.rawTable, columns);
      const detection = detectMapping(columns, ranges);
      mapping = detection.mapping;
      chartable = detection.chartable;
      warnings.push(...detection.warnings);
    }
    const info: DatasetInfo = {
      name: args.name,
      rawTable: args.rawTable,
      sourceName: args.sourceName,
      format: args.format,
      sizeBytes: args.sizeBytes,
      rawRows,
      rows: rawRows,
      columns,
      mapping,
      chartable,
      symbols: [],
      start: null,
      end: null,
      medianIntervalSec: null,
      duplicatesRemoved: 0,
      nullRowsRemoved: 0,
      outOfOrderRows: 0,
      rejected: args.rejected,
      warnings,
      ingestMs: 0,
      createdAt: Date.now(),
    };
    if (chartable) {
      await this.normalizeInto(info);
      if (info.rows === 0) {
        info.chartable = false;
        info.warnings.push("No rows had a parseable timestamp and price; check the column mapping.");
        await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(info.name)}`);
        await this.driver.query(`CREATE OR REPLACE VIEW ${quoteIdent(info.name)} AS SELECT * FROM ${quoteIdent(info.rawTable)}`);
        info.rows = rawRows;
      }
    } else {
      await this.driver.query(`CREATE OR REPLACE VIEW ${quoteIdent(info.name)} AS SELECT * FROM ${quoteIdent(info.rawTable)}`);
    }
    info.ingestMs = Math.round(performance.now() - args.started);
    this.datasets.set(info.name, info);
    await this.saveRegistry(info);
    await this.checkpoint();
    return info;
  }

  private async normalizeInto(info: DatasetInfo): Promise<void> {
    const sql = buildNormalizeSql(info.rawTable, info.name, info.mapping, info.columns, info.name.toUpperCase());
    const stats = tableToRows(await this.driver.query(sql.stats))[0] ?? {};
    await this.dropQuietly([info.name]);
    await this.driver.query(sql.create);
    const summary = tableToRows(
      await this.driver.query(
        `SELECT count(*) AS n, CAST(epoch_ms(min(ts)) AS DOUBLE) / 1000.0 AS start_t, CAST(epoch_ms(max(ts)) AS DOUBLE) / 1000.0 AS end_t FROM ${quoteIdent(info.name)}`,
      ),
    )[0];
    const symbols = tableToRows(
      await this.driver.query(`SELECT symbol, count(*) AS n FROM ${quoteIdent(info.name)} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5000`),
    ).map((r) => String(r.symbol));
    info.rows = Number(summary?.n ?? 0);
    info.start = summary?.start_t == null || Number.isNaN(Number(summary.start_t)) ? null : Number(summary.start_t);
    info.end = summary?.end_t == null || Number.isNaN(Number(summary.end_t)) ? null : Number(summary.end_t);
    info.symbols = symbols;
    info.duplicatesRemoved = Number(stats.duplicates ?? 0);
    info.nullRowsRemoved = Number(stats.null_rows ?? 0);
    info.outOfOrderRows = Number(stats.out_of_order ?? 0);
    if (info.duplicatesRemoved > 0) info.warnings.push(`${info.duplicatesRemoved.toLocaleString()} duplicate timestamp row(s) collapsed (last value kept).`);
    if (info.nullRowsRemoved > 0) info.warnings.push(`${info.nullRowsRemoved.toLocaleString()} row(s) without a parseable timestamp or price were excluded from the OHLCV view (still present in ${info.rawTable}).`);
    if (symbols.length > 0) {
      const med = tableToRows(
        await this.driver.query(
          `SELECT median(d) AS m FROM (SELECT (epoch_ms(ts) - epoch_ms(lag(ts) OVER (ORDER BY ts))) / 1000.0 AS d FROM ${quoteIdent(info.name)} WHERE symbol = ${quoteLiteral(symbols[0])}) WHERE d > 0`,
        ),
      )[0];
      const m = Number(med?.m);
      info.medianIntervalSec = Number.isFinite(m) && m > 0 ? m : null;
    }
  }

  async remap(name: string, mapping: ColumnMapping): Promise<DatasetInfo> {
    return this.serial.run(async () => {
      const ds = this.getDataset(name);
      const errors = validateMapping(mapping, ds.columns);
      if (errors.length) throw new EngineError("BAD_MAPPING", errors.join(" "));
      const started = performance.now();
      await this.dropQuietly([ds.name]);
      return this.finalizeDataset({
        name: ds.name,
        rawTable: ds.rawTable,
        sourceName: ds.sourceName,
        format: ds.format,
        sizeBytes: ds.sizeBytes,
        rejected: ds.rejected,
        warnings: ds.rejected.count > 0 ? [`${ds.rejected.count.toLocaleString()} malformed row(s) were quarantined and not imported.`] : [],
        started,
        mapping,
      });
    });
  }

  async dropDataset(name: string): Promise<void> {
    return this.serial.run(async () => {
      const ds = this.getDataset(name);
      await this.dropQuietly([ds.name, ds.rawTable]);
      this.datasets.delete(name);
      await this.driver.query(`DELETE FROM ${REGISTRY} WHERE name = ${quoteLiteral(name)}`);
      await this.checkpoint();
    });
  }

  private async dropQuietly(names: string[]): Promise<void> {
    for (const n of names) {
      await this.driver.query(`DROP VIEW IF EXISTS ${quoteIdent(n)}`).catch(() => undefined);
      await this.driver.query(`DROP TABLE IF EXISTS ${quoteIdent(n)}`).catch(() => undefined);
    }
  }

  private async checkpoint(): Promise<void> {
    await this.driver.query("CHECKPOINT").catch(() => undefined);
    await this.driver.flush?.().catch(() => undefined);
  }

  async generateSample(options: SampleOptions, progress?: ProgressFn): Promise<DatasetInfo> {
    return this.serial.run(async () => {
      const started = performance.now();
      const intraday = options.kind === "intraday";
      const bars = assertInt(options.bars ?? (intraday ? 250_000 : 2_520), "bars", 10, 5_000_000);
      const seed = options.seed ?? 0.42;
      const base = options.tableName ?? (intraday ? "sample_crypto_1m" : "sample_equities_daily");
      const name = toTableName(base, this.takenNames());
      const rawTable = `${name}_raw`;
      progress?.("generating", { bars });
      const symbols = intraday
        ? `('BTCX', 42000.0, 0.35, 0.65), ('ETHX', 2300.0, 0.25, 0.80)`
        : `('ACME', 100.0, 0.09, 0.22), ('GLOBX', 45.0, 0.14, 0.38), ('INITECH', 250.0, 0.05, 0.17)`;
      const dt = intraday ? 1 / (365 * 1440) : 1 / 252;
      const timeline = intraday
        ? `SELECT r AS ts FROM range(TIMESTAMP '2024-01-01 00:00:00', TIMESTAMP '2024-01-01 00:00:00' + to_minutes(${bars}), INTERVAL 1 MINUTE) t(r)`
        : `SELECT r AS ts FROM range(TIMESTAMP '2015-01-02', TIMESTAMP '2015-01-02' + to_days(${Math.ceil((bars * 7) / 5) + 14}), INTERVAL 1 DAY) t(r) WHERE dayofweek(r) BETWEEN 1 AND 5`;
      await this.driver.query(`SELECT setseed(${Math.min(0.999, Math.max(-0.999, seed))})`);
      await this.driver.query(`
CREATE OR REPLACE TABLE ${quoteIdent(rawTable)} AS
WITH syms AS (SELECT * FROM (VALUES ${symbols}) v(symbol, p0, mu, sigma)),
timeline AS (${timeline}),
grid AS (
  SELECT s.symbol, s.p0, s.mu, s.sigma, t.ts,
         row_number() OVER (PARTITION BY s.symbol ORDER BY t.ts) AS i
  FROM syms s CROSS JOIN timeline t
),
noise AS (
  SELECT *,
    sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()) AS z1,
    sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()) AS z2,
    sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()) AS z3,
    sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()) AS z4,
    random() AS u
  FROM grid WHERE i <= ${bars}
),
rets AS (
  SELECT *,
    sigma * (1 + 0.6 * sin(i / 180.0) + 0.25 * sin(i / 23.0)) AS vol,
    (mu - 0.5 * sigma * sigma) * ${dt} + sigma * (1 + 0.6 * sin(i / 180.0) + 0.25 * sin(i / 23.0)) * sqrt(${dt}) * z1
      + CASE WHEN u < 0.003 THEN 0.04 * z4 ELSE 0 END AS r
  FROM noise
),
path AS (
  SELECT *, p0 * exp(sum(r) OVER (PARTITION BY symbol ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS close
  FROM rets
),
bars AS (
  SELECT *, COALESCE(lag(close) OVER (PARTITION BY symbol ORDER BY i), p0) * exp(vol * sqrt(${dt}) * 0.25 * z2) AS open
  FROM path
)
SELECT
  ts AS ${intraday ? "timestamp" : "date"},
  symbol,
  round(open, 4) AS open,
  round(greatest(open, close) * exp(abs(z3) * vol * sqrt(${dt}) * 0.6), 4) AS high,
  round(least(open, close) * exp(-abs(z4) * vol * sqrt(${dt}) * 0.6), 4) AS low,
  round(close, 4) AS close,
  round(${intraday ? 25 : 1_000_000} * exp(0.35 * z2) * (1 + 40 * abs(r))) AS volume
FROM bars
ORDER BY symbol, ts`);
      return this.finalizeDataset({
        name,
        rawTable,
        sourceName: intraday ? "Synthetic 1-minute crypto (GBM + jumps)" : "Synthetic daily equities (GBM + regime vol)",
        format: "sample",
        sizeBytes: 0,
        rejected: { count: 0, samples: [] },
        warnings: [],
        started,
      });
    });
  }

  // ---------------------------------------------------------------- bars & indicators

  async bars(request: BarsRequest): Promise<BarsResult> {
    return this.serial.run(async () => {
      const started = performance.now();
      const ds = this.getDataset(request.dataset);
      if (!ds.chartable) throw new EngineError("NOT_CHARTABLE", `Dataset "${ds.name}" has no timestamp/price mapping`);
      const symbol = request.symbol && ds.symbols.includes(request.symbol) ? request.symbol : ds.symbols[0];
      if (!symbol) throw new EngineError("EMPTY_DATASET", `Dataset "${ds.name}" has no rows`);
      const indicators = (request.indicators ?? []).map(validateIndicator);
      const maxBars = assertInt(request.maxBars ?? DEFAULT_MAX_BARS, "maxBars", 100, 500_000);
      const span = ds.start != null && ds.end != null ? (request.to ?? ds.end) - (request.from ?? ds.start) : 0;
      const symbolRows = await this.symbolRowCount(ds.name, symbol, request.from, request.to);
      const timeframe = resolveTimeframe(request.timeframe, span, symbolRows, ds.medianIntervalSec, maxBars);
      const { sql, aliases } = buildBarsQuery(
        { table: ds.name, symbol, timeframe, from: request.from, to: request.to },
        indicators,
      );
      const table = await this.driver.query(sql);
      const n = table.numRows;
      const col = (name: string) => vectorToFloat64(table.getChild(name), n);
      const time = col("t");
      const open = col("open");
      const high = col("high");
      const low = col("low");
      const close = col("close");
      const volume = col("volume");
      const sqlColumns: Record<string, Float64Array> = {};
      for (const alias of aliases) sqlColumns[alias] = col(alias);
      const series = assembleIndicators(indicators, { open, high, low, close, volume }, sqlColumns);
      return {
        dataset: ds.name,
        symbol,
        timeframe,
        bucketSeconds: timeframe === "raw" ? ds.medianIntervalSec : null,
        time,
        open,
        high,
        low,
        close,
        volume,
        indicators: series,
        sourceRows: symbolRows,
        queryMs: Math.round(performance.now() - started),
        sql: sql.trim(),
      };
    });
  }

  private async symbolRowCount(table: string, symbol: string, from?: number | null, to?: number | null): Promise<number> {
    const where = [`symbol = ${quoteLiteral(symbol)}`];
    if (from != null) where.push(`ts >= make_timestamp(CAST(${Math.floor(from * 1e6)} AS BIGINT))`);
    if (to != null) where.push(`ts <= make_timestamp(CAST(${Math.floor(to * 1e6)} AS BIGINT))`);
    const row = tableToRows(await this.driver.query(`SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE ${where.join(" AND ")}`))[0];
    return Number(row?.n ?? 0);
  }

  // ---------------------------------------------------------------- SQL console

  async runQuery(sql: string, maxRows = DEFAULT_MAX_ROWS): Promise<QueryResult> {
    return this.serial.run(async () => {
      const started = performance.now();
      const limit = assertInt(maxRows, "maxRows", 1, 1_000_000);
      const statements = splitStatements(sql);
      if (statements.length === 0) throw new EngineError("EMPTY_QUERY", "Nothing to run");
      let mutated = false;
      try {
        for (let i = 0; i < statements.length - 1; i++) {
          if (!READ_ONLY_LEADING.has(firstKeyword(statements[i]))) mutated = true;
          await this.driver.query(statements[i]);
        }
        const last = statements[statements.length - 1];
        if (!READ_ONLY_LEADING.has(firstKeyword(last))) mutated = true;
        const stream = await this.driver.stream(last);
        const batches: RecordBatch[] = [];
        let rows = 0;
        let truncated = false;
        for await (const batch of stream) {
          if (rows >= limit) {
            truncated = true;
            break;
          }
          batches.push(batch);
          rows += batch.numRows;
        }
        if (truncated) await this.driver.cancel().catch(() => false);
        if (rows > limit) truncated = true;
        const { columns, rowCount } = batchesToColumns(batches, limit);
        if (mutated) await this.syncRegistry();
        return {
          columns,
          rowCount,
          truncated,
          elapsedMs: Math.round(performance.now() - started),
          statementCount: statements.length,
          mutatedCatalog: mutated,
        };
      } catch (error) {
        if (mutated) await this.syncRegistry().catch(() => undefined);
        throw new EngineError("QUERY_FAILED", errorMessage(error));
      }
    });
  }

  /** Drops registry entries whose tables were removed through the SQL console. */
  private async syncRegistry(): Promise<void> {
    const existing = new Set(
      tableToRows(await this.driver.query("SELECT table_name AS n FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views() WHERE NOT internal")).map(
        (r) => String(r.n),
      ),
    );
    for (const ds of Array.from(this.datasets.values())) {
      if (!existing.has(ds.name)) {
        this.datasets.delete(ds.name);
        await this.driver.query(`DELETE FROM ${REGISTRY} WHERE name = ${quoteLiteral(ds.name)}`);
      }
    }
  }

  async cancel(): Promise<boolean> {
    // Intentionally not serialized: it must interrupt the query currently holding the lock.
    return this.driver.cancel();
  }

  /** Read-only query for agents: rejects writes, returns at most `maxRows` plain rows. */
  async agentQuery(sql: string, maxRows = 200): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; elapsedMs: number }> {
    const statement = assertReadOnlySql(sql);
    return this.serial.run(async () => {
      const started = performance.now();
      const limit = assertInt(maxRows, "maxRows", 1, 5000);
      const firstWord = firstKeyword(statement);
      const wrapped = ["SELECT", "WITH", "FROM", "VALUES", "TABLE"].includes(firstWord)
        ? `SELECT * FROM (${statement}) AS __agent LIMIT ${limit + 1}`
        : statement;
      let table: Table;
      try {
        table = await this.driver.query(wrapped);
      } catch (error) {
        throw new EngineError("QUERY_FAILED", errorMessage(error));
      }
      const rows = tableToRows(table, limit);
      return {
        columns: table.schema.fields.map((f) => f.name),
        rows,
        truncated: table.numRows > limit,
        elapsedMs: Math.round(performance.now() - started),
      };
    });
  }

  async catalog(): Promise<CatalogTable[]> {
    return this.serial.run(async () => {
      const tables = tableToRows(
        await this.driver.query(
          `SELECT table_name AS name, 'table' AS kind, CAST(estimated_size AS DOUBLE) AS rows FROM duckdb_tables()
           UNION ALL SELECT view_name, 'view', NULL FROM duckdb_views() WHERE NOT internal`,
        ),
      );
      const cols = tableToRows(
        await this.driver.query(
          `SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE NOT internal ORDER BY table_name, column_index`,
        ),
        200_000,
      );
      const byTable = new Map<string, SourceColumn[]>();
      for (const c of cols) {
        const list = byTable.get(String(c.table_name)) ?? [];
        list.push({ name: String(c.column_name), type: String(c.data_type) });
        byTable.set(String(c.table_name), list);
      }
      const datasetTables = new Set(Array.from(this.datasets.values()).flatMap((d) => [d.name, d.rawTable]));
      return tables
        .map((t) => ({
          name: String(t.name),
          kind: (t.kind === "view" ? "view" : "table") as "table" | "view",
          rows: t.rows == null ? null : Number(t.rows),
          columns: byTable.get(String(t.name)) ?? [],
          dataset: datasetTables.has(String(t.name)),
          internal: String(t.name).startsWith("__qa"),
        }))
        .sort((a, b) => Number(b.dataset) - Number(a.dataset) || a.name.localeCompare(b.name));
    });
  }

  // ---------------------------------------------------------------- data quality

  async quality(name: string): Promise<QualityReport> {
    return this.serial.run(async () => {
      const started = performance.now();
      const ds = this.getDataset(name);
      const issues: QualityIssue[] = [];
      if (ds.rejected.count > 0) {
        issues.push({
          id: "rejected",
          severity: "error",
          title: "Malformed CSV rows quarantined",
          detail: "These lines did not match the file's column structure and were not imported.",
          count: ds.rejected.count,
          examples: ds.rejected.samples.slice(0, 5).map((s) => ({ line: s.line, error: s.errorType, message: s.message, row: s.csvLine })),
        });
      }
      if (!ds.chartable) {
        issues.push({
          id: "unmapped",
          severity: "warning",
          title: "No OHLCV mapping",
          detail: "A timestamp and price column could not be detected; map them manually to enable charts, quality checks and backtests.",
          count: 1,
          examples: [],
        });
        return { dataset: ds.name, score: 50, rows: ds.rawRows, symbols: 0, start: null, end: null, issues, elapsedMs: Math.round(performance.now() - started) };
      }
      if (ds.nullRowsRemoved > 0) {
        issues.push({
          id: "null_rows",
          severity: "warning",
          title: "Rows without timestamp or price",
          detail: `Excluded from the OHLCV view; still available in ${ds.rawTable}.`,
          count: ds.nullRowsRemoved,
          examples: [],
        });
      }
      if (ds.duplicatesRemoved > 0) {
        issues.push({
          id: "duplicates",
          severity: "warning",
          title: "Duplicate timestamps",
          detail: "Multiple rows shared a (symbol, timestamp); the last occurrence in file order was kept.",
          count: ds.duplicatesRemoved,
          examples: [],
        });
      }
      if (ds.outOfOrderRows > 0) {
        issues.push({
          id: "out_of_order",
          severity: "info",
          title: "Out-of-order rows in source",
          detail: "The source file was not sorted by time. Data has been re-sorted.",
          count: ds.outOfOrderRows,
          examples: [],
        });
      }
      const t = quoteIdent(ds.name);
      const base = `
WITH b AS (
  SELECT symbol, ts, open, high, low, close, volume,
    (epoch_ms(ts) - epoch_ms(lag(ts) OVER w)) / 1000.0 AS dt,
    CASE WHEN close > 0 AND lag(close) OVER w > 0 THEN ln(close / lag(close) OVER w) END AS lr,
    close = lag(close) OVER w AS same
  FROM ${t}
  WINDOW w AS (PARTITION BY symbol ORDER BY ts)
),
s AS (
  SELECT symbol, median(dt) FILTER (WHERE dt > 0) AS med_dt, stddev_samp(lr) FILTER (WHERE isfinite(lr)) AS sd_lr
  FROM b GROUP BY symbol
),
x AS (SELECT b.*, s.med_dt, s.sd_lr FROM b JOIN s USING (symbol))`;
      const checks: { id: string; severity: QualityIssue["severity"]; title: string; detail: string; where: string; order: string }[] = [
        {
          id: "ohlc_violation",
          severity: "error",
          title: "OHLC consistency violations",
          detail: "high < low, or open/close outside the [low, high] range.",
          where: "high < low - 1e-9 * abs(low) OR open > high + 1e-9 * abs(high) OR open < low - 1e-9 * abs(low) OR close > high + 1e-9 * abs(high) OR close < low - 1e-9 * abs(low)",
          order: "ts",
        },
        {
          id: "non_positive",
          severity: "error",
          title: "Non-positive prices",
          detail: "Zero or negative prices break returns and log-return math.",
          where: "open <= 0 OR high <= 0 OR low <= 0 OR close <= 0",
          order: "ts",
        },
        {
          id: "negative_volume",
          severity: "error",
          title: "Negative volume",
          detail: "Volume should never be negative.",
          where: "volume < 0",
          order: "ts",
        },
        {
          id: "return_outliers",
          severity: "warning",
          title: "Extreme return outliers",
          detail: "Bar-to-bar log returns larger than 8 standard deviations; often bad ticks or unadjusted splits.",
          where: "sd_lr > 0 AND abs(lr) > 8 * sd_lr",
          order: "abs(lr) DESC",
        },
        {
          id: "gaps",
          severity: "info",
          title: "Time gaps",
          detail: "Spacing larger than 5x the median bar interval (weekends/holidays for daily data, sessions for intraday).",
          where: "med_dt > 0 AND dt > 5 * med_dt",
          order: "dt DESC",
        },
      ];
      for (const check of checks) {
        const count = Number(
          tableToRows(await this.driver.query(`${base} SELECT count(*) AS n FROM x WHERE ${check.where}`))[0]?.n ?? 0,
        );
        if (count === 0) continue;
        const examples = tableToRows(
          await this.driver.query(
            `${base} SELECT symbol, strftime(ts, '%Y-%m-%d %H:%M:%S') AS ts, open, high, low, close, volume, round(dt, 1) AS gap_seconds, round(lr, 6) AS log_return FROM x WHERE ${check.where} ORDER BY ${check.order} LIMIT 5`,
          ),
        ).map((r) => {
          const out: Record<string, string | number | null> = {};
          for (const [k, v] of Object.entries(r)) out[k] = v == null ? null : typeof v === "number" ? v : String(v);
          return out;
        });
        issues.push({ id: check.id, severity: check.severity, title: check.title, detail: check.detail, count, examples });
      }
      const staleRows = tableToRows(
        await this.driver.query(`
WITH l AS (
  SELECT symbol, ts, close, CASE WHEN close = lag(close) OVER (PARTITION BY symbol ORDER BY ts) THEN 0 ELSE 1 END AS brk
  FROM ${t}
),
b AS (
  SELECT symbol, ts, close, sum(brk) OVER (PARTITION BY symbol ORDER BY ts ROWS UNBOUNDED PRECEDING) AS grp FROM l
),
runs AS (SELECT symbol, grp, count(*) AS len, min(ts) AS first_ts, any_value(close) AS close FROM b GROUP BY symbol, grp HAVING count(*) >= 10)
SELECT symbol, strftime(first_ts, '%Y-%m-%d %H:%M:%S') AS ts, close, len, count(*) OVER () AS total FROM runs ORDER BY len DESC LIMIT 5`),
      );
      if (staleRows.length > 0) {
        issues.push({
          id: "stale_prices",
          severity: "warning",
          title: "Stale price runs",
          detail: "10 or more consecutive bars with an unchanged close; may indicate a halted feed or forward-filled data.",
          count: Number(staleRows[0].total),
          examples: staleRows.map((r) => ({ symbol: String(r.symbol), ts: String(r.ts), close: Number(r.close), bars: Number(r.len) })),
        });
      }
      const nullVolume = Number(tableToRows(await this.driver.query(`SELECT count(*) FILTER (WHERE volume IS NULL) AS n FROM ${t}`))[0]?.n ?? 0);
      if (nullVolume > 0) {
        issues.push({
          id: "null_volume",
          severity: "info",
          title: "Missing volume",
          detail: "Volume-based indicators (VWAP) will be empty for these bars.",
          count: nullVolume,
          examples: [],
        });
      }
      const rows = Math.max(1, ds.rows);
      let score = 100;
      for (const issue of issues) {
        const ratio = Math.min(1, issue.count / rows);
        if (issue.severity === "error") score -= Math.min(40, 10 + 300 * ratio);
        else if (issue.severity === "warning") score -= Math.min(20, 4 + 100 * ratio);
        else score -= Math.min(4, 1 + 10 * ratio);
      }
      const order = { error: 0, warning: 1, info: 2 } as const;
      issues.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
      return {
        dataset: ds.name,
        score: Math.max(0, Math.round(score)),
        rows: ds.rows,
        symbols: ds.symbols.length,
        start: ds.start,
        end: ds.end,
        issues,
        elapsedMs: Math.round(performance.now() - started),
      };
    });
  }

  // ---------------------------------------------------------------- backtesting

  async backtest(request: BacktestRequest): Promise<BacktestResult> {
    const strategy = validateStrategy(request.strategy);
    const customSql = strategy.type === "custom_sql" ? assertReadOnlySql(strategy.sql) : null;
    return this.serial.run(async () => {
      const started = performance.now();
      const ds = this.getDataset(request.dataset);
      if (!ds.chartable) throw new EngineError("NOT_CHARTABLE", `Dataset "${ds.name}" has no timestamp/price mapping`);
      const symbol = request.symbol && ds.symbols.includes(request.symbol) ? request.symbol : ds.symbols[0];
      if (!symbol) throw new EngineError("EMPTY_DATASET", "Dataset has no rows");
      const rows = await this.symbolRowCount(ds.name, symbol, request.from, request.to);
      const span = ds.start != null && ds.end != null ? (request.to ?? ds.end) - (request.from ?? ds.start) : 0;
      const timeframe = resolveTimeframe(request.timeframe as Timeframe, span, rows, ds.medianIntervalSec, 2_000_000);
      const opts = { table: ds.name, symbol, timeframe, from: request.from, to: request.to };
      const { sql } = buildBarsQuery(opts, []);
      const table = await this.driver.query(sql);
      const n = table.numRows;
      if (n < 3) throw new EngineError("NOT_ENOUGH_DATA", "At least 3 bars are required for a backtest");
      const time = vectorToFloat64(table.getChild("t"), n);
      const close = vectorToFloat64(table.getChild("close"), n);
      let target: Float64Array;
      if (customSql) {
        let signals: Table;
        try {
          signals = await this.driver.query(
            `WITH bars AS (${buildBarsCte(opts)}) SELECT CAST(epoch_ms(ts) AS DOUBLE) / 1000.0 AS t, CAST(position AS DOUBLE) AS position FROM (${customSql}) AS __signal ORDER BY 1`,
          );
        } catch (error) {
          throw new EngineError(
            "STRATEGY_SQL_FAILED",
            `Custom strategy SQL failed. It must select "ts" and "position" columns from the "bars" CTE (ts, open, high, low, close, volume). ${errorMessage(error)}`,
          );
        }
        const st = vectorToFloat64(signals.getChild("t"), signals.numRows);
        const sp = vectorToFloat64(signals.getChild("position"), signals.numRows);
        const aligned = new Float64Array(n);
        let j = 0;
        let current = 0;
        for (let i = 0; i < n; i++) {
          while (j < st.length && st[j] <= time[i] + 1e-6) {
            current = Number.isFinite(sp[j]) ? sp[j] : 0;
            j++;
          }
          aligned[i] = current;
        }
        target = sanitizeTargets(aligned, request.allowShort);
      } else {
        target = strategyTargets(strategy as Exclude<typeof strategy, { type: "custom_sql" }>, close, request.allowShort);
      }
      const costBps = Math.max(0, request.feeBps) + Math.max(0, request.slippageBps);
      const capital = request.initialCapital > 0 ? request.initialCapital : 100_000;
      const sim = simulate({ time, close, target, costBps, initialCapital: capital });
      const bench = simulate({ time, close, target: new Float64Array(n).fill(1), costBps, initialCapital: capital });
      const metrics = computeMetrics(sim, time, capital);
      const benchmark = computeMetrics(bench, time, capital);
      const curve = downsampleCurves(time, sim.equity, bench.equity, sim.drawdown, 3000);
      const maxTrades = 1000;
      return {
        dataset: ds.name,
        symbol,
        timeframe,
        strategy,
        metrics,
        benchmark,
        curve,
        trades: sim.trades.slice(-maxTrades),
        tradesTruncated: sim.trades.length > maxTrades,
        monthly: monthlyReturns(time, sim.equity),
        returnHistogram: returnHistogram(sim.returns),
        elapsedMs: Math.round(performance.now() - started),
      };
    });
  }

  // ---------------------------------------------------------------- export & stats

  async exportData(request: ExportRequest): Promise<ExportResult> {
    return this.serial.run(async () => {
      const source = request.table ? `SELECT * FROM ${quoteIdent(request.table)}` : request.sql ? splitStatements(request.sql).pop() : undefined;
      if (!source) throw new EngineError("BAD_REQUEST", "Nothing to export");
      const baseName = request.table ?? "query_result";
      if (request.format === "csv") {
        const file = `__qa_export_${Date.now()}.csv`;
        try {
          await this.driver.query(`COPY (${source}) TO ${quoteLiteral(file)} (FORMAT CSV, HEADER)`);
          const bytes = await this.driver.copyFileToBuffer(file);
          const rows = Math.max(0, new TextDecoder().decode(bytes).split("\n").filter(Boolean).length - 1);
          return { bytes, fileName: `${baseName}.csv`, mime: "text/csv", rows };
        } catch (error) {
          throw new EngineError("EXPORT_FAILED", errorMessage(error));
        } finally {
          await this.driver.dropFile(file).catch(() => undefined);
        }
      }
      let table: Table;
      try {
        table = await this.driver.query(source);
      } catch (error) {
        throw new EngineError("EXPORT_FAILED", errorMessage(error));
      }
      const { columns, rowCount } = tableToColumns(table);
      return { bytes: writeParquet(columns, rowCount), fileName: `${baseName}.parquet`, mime: "application/vnd.apache.parquet", rows: rowCount };
    });
  }

  async stats(): Promise<EngineStats> {
    return this.serial.run(async () => {
      const mem = tableToRows(await this.driver.query("SELECT CAST(sum(memory_usage_bytes) AS DOUBLE) AS m FROM duckdb_memory()"))[0];
      const tables = tableToRows(await this.driver.query("SELECT count(*) AS n FROM duckdb_tables()"))[0];
      return {
        memoryBytes: Number(mem?.m ?? 0),
        wasmHeapBytes: await this.driver.heapBytes(),
        tables: Number(tables?.n ?? 0),
      };
    });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
