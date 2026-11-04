import { assertFinite, assertInt, num, quoteIdent, quoteLiteral } from "./sql";
import { isNumericType, isStringType } from "./schema-detect";
import type { ColumnMapping, IndicatorSpec, SourceColumn, Timeframe, TsKind } from "./types";
import { TIMEFRAME_SECONDS } from "./types";

/** Parse formats tried (in order) for string timestamps that DuckDB cannot cast directly. */
export const STRING_TS_FORMATS = [
  "%Y-%m-%dT%H:%M:%S.%fZ",
  "%Y-%m-%dT%H:%M:%SZ",
  "%Y-%m-%d %H:%M:%S%z",
  "%m/%d/%Y %H:%M:%S",
  "%m/%d/%Y %H:%M",
  "%m/%d/%Y",
  "%d.%m.%Y %H:%M:%S",
  "%d.%m.%Y",
  "%Y/%m/%d %H:%M:%S",
  "%Y/%m/%d",
  "%Y%m%d %H:%M:%S",
  "%Y%m%d",
  "%d-%b-%Y",
  "%d %b %Y",
  "%b %d, %Y",
  "%d-%m-%Y",
];

export function timestampExpr(column: string, kind: TsKind): string {
  const c = quoteIdent(column);
  switch (kind) {
    case "native":
      return `CAST(${c} AS TIMESTAMP)`;
    case "epoch_s":
      return `make_timestamp(CAST(round(CAST(${c} AS DOUBLE) * 1000000) AS BIGINT))`;
    case "epoch_ms":
      return `make_timestamp(CAST(round(CAST(${c} AS DOUBLE) * 1000) AS BIGINT))`;
    case "epoch_us":
      return `make_timestamp(CAST(${c} AS BIGINT))`;
    case "epoch_ns":
      return `make_timestamp(CAST(CAST(${c} AS HUGEINT) // 1000 AS BIGINT))`;
    case "yyyymmdd":
      return `try_strptime(CAST(CAST(${c} AS BIGINT) AS VARCHAR), '%Y%m%d')`;
    case "string": {
      const formats = `[${STRING_TS_FORMATS.map(quoteLiteral).join(", ")}]`;
      const trimmed = `trim(CAST(${c} AS VARCHAR))`;
      return `COALESCE(TRY_CAST(${trimmed} AS TIMESTAMP), try_strptime(${trimmed}, ${formats}))`;
    }
  }
}

/** Numeric conversion that tolerates "$1,234.50", " 12 " and similar formatted strings. */
export function numericExpr(column: string, columns: SourceColumn[]): string {
  const col = columns.find((c) => c.name === column);
  const c = quoteIdent(column);
  if (col && isNumericType(col.type)) return `CAST(${c} AS DOUBLE)`;
  if (col && isStringType(col.type)) {
    return `TRY_CAST(nullif(regexp_replace(trim(${c}), '[$€£¥,_\\s]', '', 'g'), '') AS DOUBLE)`;
  }
  return `TRY_CAST(${c} AS DOUBLE)`;
}

export interface NormalizeSql {
  /** Statement creating the normalized table. */
  create: string;
  /** Statement returning a single row of integrity counters for the projection. */
  stats: string;
}

/**
 * Builds the SQL that projects a raw table onto the canonical OHLCV layout:
 *   symbol VARCHAR, ts TIMESTAMP, open/high/low/close/volume DOUBLE
 * Rows without a timestamp or close are excluded, duplicates on (symbol, ts) keep the last
 * occurrence in file order, and results are physically sorted for fast range scans.
 */
export function buildNormalizeSql(
  rawTable: string,
  normTable: string,
  mapping: ColumnMapping,
  columns: SourceColumn[],
  defaultSymbol: string,
): NormalizeSql {
  if (!mapping.ts || !mapping.close) throw new Error("Mapping requires ts and close columns");
  const close = numericExpr(mapping.close, columns);
  const open = mapping.open ? numericExpr(mapping.open, columns) : close;
  const highRaw = mapping.high ? numericExpr(mapping.high, columns) : null;
  const lowRaw = mapping.low ? numericExpr(mapping.low, columns) : null;
  const volume = mapping.volume ? numericExpr(mapping.volume, columns) : "CAST(NULL AS DOUBLE)";
  const symbol = mapping.symbol
    ? `COALESCE(NULLIF(trim(CAST(${quoteIdent(mapping.symbol)} AS VARCHAR)), ''), ${quoteLiteral(defaultSymbol)})`
    : quoteLiteral(defaultSymbol);
  const projection = `
    SELECT
      rowid AS __row,
      ${symbol} AS symbol,
      ${timestampExpr(mapping.ts, mapping.tsKind)} AS ts,
      ${open} AS open,
      ${highRaw ?? "NULL"} AS high_src,
      ${lowRaw ?? "NULL"} AS low_src,
      ${close} AS close,
      ${volume} AS volume
    FROM ${quoteIdent(rawTable)}`;
  const create = `
CREATE OR REPLACE TABLE ${quoteIdent(normTable)} AS
WITH src AS (${projection}),
valid AS (
  SELECT
    __row, symbol, ts,
    COALESCE(open, close) AS open,
    COALESCE(CAST(high_src AS DOUBLE), greatest(COALESCE(open, close), close)) AS high,
    COALESCE(CAST(low_src AS DOUBLE), least(COALESCE(open, close), close)) AS low,
    close, volume
  FROM src
  WHERE ts IS NOT NULL AND close IS NOT NULL AND isfinite(close)
)
SELECT symbol, ts, open, high, low, close, volume
FROM valid
QUALIFY row_number() OVER (PARTITION BY symbol, ts ORDER BY __row DESC) = 1
ORDER BY symbol, ts`;
  const stats = `
WITH src AS (${projection}),
flagged AS (
  SELECT
    symbol, ts, close,
    ts < lag(ts) OVER (PARTITION BY symbol ORDER BY __row) AS out_of_order
  FROM src
)
SELECT
  count(*)::DOUBLE AS raw_rows,
  count(*) FILTER (WHERE ts IS NULL OR close IS NULL OR NOT isfinite(close))::DOUBLE AS null_rows,
  (count(*) FILTER (WHERE ts IS NOT NULL AND close IS NOT NULL AND isfinite(close))
    - count(DISTINCT (symbol, ts)) FILTER (WHERE ts IS NOT NULL AND close IS NOT NULL AND isfinite(close)))::DOUBLE AS duplicates,
  count(*) FILTER (WHERE out_of_order)::DOUBLE AS out_of_order
FROM flagged`;
  return { create, stats };
}

/** Picks a resampling timeframe so that the bar count stays under maxBars. */
export function resolveTimeframe(
  requested: Timeframe,
  spanSeconds: number,
  rowCount: number,
  medianIntervalSec: number | null,
  maxBars: number,
): Exclude<Timeframe, "auto"> {
  if (requested !== "auto") return requested;
  if (rowCount <= maxBars) return "raw";
  const native = medianIntervalSec && medianIntervalSec > 0 ? medianIntervalSec : 0;
  const ordered = Object.entries(TIMEFRAME_SECONDS).sort((a, b) => a[1] - b[1]) as [Exclude<Timeframe, "auto" | "raw">, number][];
  for (const [tf, seconds] of ordered) {
    if (seconds < native) continue;
    if (spanSeconds / seconds <= maxBars) return tf;
  }
  return "1M";
}

export function timeframeInterval(tf: Exclude<Timeframe, "auto" | "raw">): string {
  switch (tf) {
    case "1w":
      return "INTERVAL '7 days'";
    case "1M":
      return "INTERVAL '1 month'";
    default:
      return `INTERVAL '${TIMEFRAME_SECONDS[tf]} seconds'`;
  }
}

export interface BarsSqlOptions {
  table: string;
  symbol: string;
  timeframe: Exclude<Timeframe, "auto">;
  from?: number | null;
  to?: number | null;
}

/**
 * CTE body producing resampled bars as (ts TIMESTAMP, open, high, low, close, volume).
 * `from`/`to` are unix seconds.
 */
export function buildBarsCte({ table, symbol, timeframe, from, to }: BarsSqlOptions): string {
  const where = [`symbol = ${quoteLiteral(symbol)}`];
  if (from != null) where.push(`ts >= make_timestamp(CAST(${Math.floor(assertFinite(from, "from", -1e12, 1e12) * 1e6)} AS BIGINT))`);
  if (to != null) where.push(`ts <= make_timestamp(CAST(${Math.floor(assertFinite(to, "to", -1e12, 1e12) * 1e6)} AS BIGINT))`);
  const filter = where.join(" AND ");
  if (timeframe === "raw") {
    return `SELECT ts, open, high, low, close, volume FROM ${quoteIdent(table)} WHERE ${filter}`;
  }
  // Weekly buckets are aligned to Mondays (DuckDB's default origin 2000-01-03 is a Monday).
  return `
    SELECT
      time_bucket(${timeframeInterval(timeframe)}, ts) AS ts,
      arg_min(open, ts) AS open,
      max(high) AS high,
      min(low) AS low,
      arg_max(close, ts) AS close,
      sum(volume) AS volume
    FROM ${quoteIdent(table)}
    WHERE ${filter}
    GROUP BY 1`;
}

/** Indicators computed in SQL with window functions; the rest are computed by worker kernels. */
export function isSqlIndicator(spec: IndicatorSpec): boolean {
  return spec.type === "sma" || spec.type === "bbands" || spec.type === "vwap" || spec.type === "volatility" || spec.type === "drawdown";
}

export function indicatorKey(spec: IndicatorSpec): string {
  switch (spec.type) {
    case "sma":
    case "ema":
    case "vwap":
    case "rsi":
    case "atr":
    case "volatility":
      return `${spec.type}_${spec.period}`;
    case "bbands":
      return `bb_${spec.period}_${String(spec.mult).replace(".", "p")}`;
    case "macd":
      return `macd_${spec.fast}_${spec.slow}_${spec.signal}`;
    case "drawdown":
      return "drawdown";
  }
}

export function validateIndicator(spec: IndicatorSpec): IndicatorSpec {
  switch (spec.type) {
    case "sma":
    case "ema":
    case "vwap":
    case "atr":
      assertInt(spec.period, `${spec.type} period`, 1, 5000);
      break;
    case "rsi":
    case "volatility":
      assertInt(spec.period, `${spec.type} period`, 2, 5000);
      break;
    case "bbands":
      assertInt(spec.period, "bbands period", 2, 5000);
      assertFinite(spec.mult, "bbands multiplier", 0.1, 10);
      break;
    case "macd":
      assertInt(spec.fast, "macd fast", 1, 1000);
      assertInt(spec.slow, "macd slow", 2, 2000);
      assertInt(spec.signal, "macd signal", 1, 1000);
      if (spec.fast >= spec.slow) throw new RangeError("macd fast period must be shorter than slow period");
      break;
    case "drawdown":
      break;
    default:
      throw new RangeError(`Unknown indicator ${(spec as { type: string }).type}`);
  }
  return spec;
}

/** SELECT-list fragments (aliased) for SQL indicators over a CTE named `bars` ordered by ts. */
export function sqlIndicatorColumns(spec: IndicatorSpec): { alias: string; expr: string }[] {
  const key = indicatorKey(spec);
  const win = (n: number) => `(ORDER BY ts ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW)`;
  switch (spec.type) {
    case "sma": {
      const w = win(spec.period);
      return [{ alias: key, expr: `CASE WHEN count(close) OVER ${w} >= ${spec.period} THEN avg(close) OVER ${w} END` }];
    }
    case "bbands": {
      const w = win(spec.period);
      const ready = `count(close) OVER ${w} >= ${spec.period}`;
      const mid = `avg(close) OVER ${w}`;
      const sd = `stddev_pop(close) OVER ${w}`;
      return [
        { alias: `${key}_mid`, expr: `CASE WHEN ${ready} THEN ${mid} END` },
        { alias: `${key}_upper`, expr: `CASE WHEN ${ready} THEN ${mid} + ${num(spec.mult)} * ${sd} END` },
        { alias: `${key}_lower`, expr: `CASE WHEN ${ready} THEN ${mid} - ${num(spec.mult)} * ${sd} END` },
      ];
    }
    case "vwap": {
      const w = win(spec.period);
      return [
        {
          alias: key,
          expr: `CASE WHEN count(close) OVER ${w} >= ${spec.period} THEN sum((high + low + close) / 3.0 * volume) OVER ${w} / nullif(sum(volume) OVER ${w}, 0) END`,
        },
      ];
    }
    case "volatility": {
      // Rolling stdev of log returns (not annualized; the UI annualizes using bar frequency).
      const w = win(spec.period);
      return [{ alias: key, expr: `CASE WHEN count(__lr) OVER ${w} >= ${spec.period} THEN stddev_samp(__lr) OVER ${w} END` }];
    }
    case "drawdown":
      return [{ alias: key, expr: `close / max(close) OVER (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - 1` }];
    default:
      return [];
  }
}

/**
 * Full bars query: resample, then add SQL indicator columns. Output columns:
 *   t (unix seconds DOUBLE), open, high, low, close, volume, <indicator aliases...>
 */
export function buildBarsQuery(options: BarsSqlOptions, indicators: IndicatorSpec[]): { sql: string; aliases: string[] } {
  const sqlSpecs = indicators.filter(isSqlIndicator);
  const cols = sqlSpecs.flatMap(sqlIndicatorColumns);
  const needsLogReturn = sqlSpecs.some((s) => s.type === "volatility");
  const extra = cols.map((c) => `, ${c.expr} AS ${quoteIdent(c.alias)}`).join("");
  const sql = `
WITH bars AS (${buildBarsCte(options)}),
prepared AS (
  SELECT *${needsLogReturn ? ", ln(close / lag(close) OVER (ORDER BY ts)) AS __lr" : ""} FROM bars
)
SELECT
  CAST(epoch_ms(ts) AS DOUBLE) / 1000.0 AS t,
  open, high, low, close, COALESCE(volume, 0) AS volume${extra}
FROM prepared
ORDER BY ts`;
  return { sql, aliases: cols.map((c) => c.alias) };
}
