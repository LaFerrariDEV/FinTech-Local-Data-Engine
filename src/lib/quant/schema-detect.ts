import type { ColumnMapping, MappingDetection, NumericRange, SourceColumn, TsKind } from "./types";

/**
 * Heuristic OHLCV column detection. Works on DuckDB column names/types (as produced by DESCRIBE)
 * and, for integer timestamp candidates, on value ranges so epoch units and YYYYMMDD integers can
 * be told apart.
 */

const SYNONYMS: Record<"ts" | "open" | "high" | "low" | "close" | "volume" | "symbol", string[]> = {
  ts: [
    "timestamp", "datetime", "date", "time", "ts", "t", "dt", "tradedate", "tradingdate", "day", "period",
    "bartime", "opentime", "candletime", "timeutc", "datetimeutc", "utc", "unixtime", "epoch", "timeperiodstart",
    "starttime", "begin", "interval",
  ],
  open: ["open", "o", "openprice", "opening", "pxopen", "openingprice", "first", "openbid", "openmid"],
  high: ["high", "h", "highprice", "max", "pxhigh", "dayhigh", "highmid"],
  low: ["low", "l", "lowprice", "min", "pxlow", "daylow", "lowmid"],
  close: [
    "close", "c", "closeprice", "closing", "closingprice", "last", "pxlast", "lastprice", "price", "settle",
    "settlement", "adjclose", "adjustedclose", "closeadj", "adjclosingprice", "value", "px", "mid", "rate", "nav",
  ],
  volume: [
    "volume", "vol", "v", "qty", "quantity", "size", "tradevolume", "basevolume", "volumeto", "volumefrom",
    "turnover", "amount", "totalvolume", "tickvolume", "realvolume",
  ],
  symbol: [
    "symbol", "ticker", "sym", "instrument", "asset", "code", "pair", "secid", "security", "ric", "isin",
    "coin", "market", "contract", "underlying", "name",
  ],
};

const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|HUGEINT|UHUGEINT|BIGINT|UBIGINT|INTEGER|UINTEGER|SMALLINT|USMALLINT|TINYINT|UTINYINT|INT\d*|FLOAT\d*)/i;
const INTEGER_TYPE = /^(HUGEINT|UHUGEINT|BIGINT|UBIGINT|INTEGER|UINTEGER|SMALLINT|USMALLINT|TINYINT|UTINYINT|INT\d*)/i;
const TEMPORAL_TYPE = /^(DATE|TIMESTAMP|DATETIME)/i;
const STRING_TYPE = /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/i;

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPE.test(type.trim());
}
export function isIntegerType(type: string): boolean {
  return INTEGER_TYPE.test(type.trim());
}
export function isTemporalType(type: string): boolean {
  return TEMPORAL_TYPE.test(type.trim());
}
export function isStringType(type: string): boolean {
  return STRING_TYPE.test(type.trim());
}

/** Score a column name against a synonym list: lower is better, Infinity means no match. */
function nameScore(normalized: string, synonyms: string[]): number {
  const exact = synonyms.indexOf(normalized);
  if (exact >= 0) return exact;
  // Partial matches only for multi-char synonyms to avoid "o" matching everything.
  for (let i = 0; i < synonyms.length; i++) {
    const syn = synonyms[i];
    if (syn.length >= 4 && normalized.includes(syn)) {
      // Penalize adjusted/derived variants so the plain column wins.
      const adjPenalty = /adj|adjusted/.test(normalized) && !/adj/.test(syn) ? 50 : 0;
      return 100 + i + adjPenalty;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** Infer the encoding of an integer/float timestamp column from its value range. */
export function inferEpochKind(range: NumericRange | undefined): TsKind {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "epoch_s";
  const { min, max } = range;
  if (min >= 18_000_101 && max <= 21_001_231 && Number.isInteger(min) && Number.isInteger(max)) return "yyyymmdd";
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  if (magnitude < 1e11) return "epoch_s";
  if (magnitude < 1e14) return "epoch_ms";
  if (magnitude < 1e17) return "epoch_us";
  return "epoch_ns";
}

export function emptyMapping(): ColumnMapping {
  return { ts: null, tsKind: "native", open: null, high: null, low: null, close: null, volume: null, symbol: null };
}

export function detectMapping(columns: SourceColumn[], ranges: Record<string, NumericRange> = {}): MappingDetection {
  const warnings: string[] = [];
  const mapping = emptyMapping();
  const used = new Set<string>();
  const normalized = columns.map((c) => ({ ...c, norm: normalizeName(c.name) }));

  const pick = (
    role: keyof typeof SYNONYMS,
    accept: (c: SourceColumn) => boolean,
  ): string | null => {
    let best: { name: string; score: number } | null = null;
    for (const col of normalized) {
      if (used.has(col.name) || !accept(col)) continue;
      const score = nameScore(col.norm, SYNONYMS[role]);
      if (score === Number.POSITIVE_INFINITY) continue;
      if (!best || score < best.score) best = { name: col.name, score };
    }
    if (best) used.add(best.name);
    return best?.name ?? null;
  };

  // 1. Timestamp: by name (temporal, integer or string types), then by temporal type alone.
  mapping.ts = pick("ts", (c) => isTemporalType(c.type) || isNumericType(c.type) || isStringType(c.type));
  if (!mapping.ts) {
    const temporal = normalized.find((c) => isTemporalType(c.type) && !used.has(c.name));
    if (temporal) {
      mapping.ts = temporal.name;
      used.add(temporal.name);
    }
  }
  if (mapping.ts) {
    const col = columns.find((c) => c.name === mapping.ts)!;
    if (isTemporalType(col.type)) mapping.tsKind = "native";
    else if (isNumericType(col.type)) mapping.tsKind = inferEpochKind(ranges[col.name]);
    else mapping.tsKind = "string";
  } else {
    warnings.push("No timestamp column detected; the dataset can be queried with SQL but not charted.");
  }

  const priceAccept = (c: SourceColumn) => isNumericType(c.type) || isStringType(c.type);
  mapping.open = pick("open", priceAccept);
  mapping.high = pick("high", priceAccept);
  mapping.low = pick("low", priceAccept);
  mapping.close = pick("close", priceAccept);
  mapping.volume = pick("volume", priceAccept);
  mapping.symbol = pick("symbol", (c) => isStringType(c.type) || (isIntegerType(c.type) && normalizeName(c.name) !== "volume"));

  // Fallback for close: a single remaining numeric column (e.g. "date,SPY").
  if (!mapping.close) {
    const remaining = normalized.filter((c) => !used.has(c.name) && isNumericType(c.type));
    if (remaining.length === 1) {
      mapping.close = remaining[0].name;
      used.add(remaining[0].name);
      warnings.push(`Using "${remaining[0].name}" as the close price.`);
    } else if (remaining.length > 1 && !mapping.open) {
      // Prefer the last numeric column as a conventional "price" column.
      warnings.push("No close/price column detected. Map one manually to enable charting.");
    }
  }

  // Wide format guard: a symbol column that is actually numeric-like is ignored.
  if (mapping.symbol) {
    const col = columns.find((c) => c.name === mapping.symbol)!;
    if (isIntegerType(col.type) && !["symbol", "ticker", "secid", "code", "instrument"].includes(normalizeName(col.name))) {
      used.delete(mapping.symbol);
      mapping.symbol = null;
    }
  }

  if (mapping.close && !mapping.open && !mapping.high && !mapping.low) {
    warnings.push("Only a close/price series was found; candles are synthesized as flat bars (O=H=L=C).");
  }
  if (mapping.ts && mapping.close && !mapping.volume) warnings.push("No volume column detected.");

  return { mapping, chartable: Boolean(mapping.ts && mapping.close), warnings };
}

/** Validates a user-supplied mapping against the available columns. */
export function validateMapping(mapping: ColumnMapping, columns: SourceColumn[]): string[] {
  const errors: string[] = [];
  const names = new Set(columns.map((c) => c.name));
  const seen = new Map<string, string>();
  for (const role of ["ts", "open", "high", "low", "close", "volume", "symbol"] as const) {
    const col = mapping[role];
    if (col == null) continue;
    if (!names.has(col)) errors.push(`Column "${col}" (mapped to ${role}) does not exist.`);
    const prior = seen.get(col);
    if (prior) errors.push(`Column "${col}" is mapped to both ${prior} and ${role}.`);
    seen.set(col, role);
  }
  if (!mapping.ts) errors.push("A timestamp column is required.");
  if (!mapping.close) errors.push("A close/price column is required.");
  return errors;
}
