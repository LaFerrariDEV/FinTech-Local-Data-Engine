/** Shared domain types used by the worker, the UI and the agent. All types are structured-clone safe. */

export type OhlcvRole = "ts" | "open" | "high" | "low" | "close" | "volume" | "symbol";

/** How the timestamp column must be converted into a DuckDB TIMESTAMP. */
export type TsKind = "native" | "epoch_s" | "epoch_ms" | "epoch_us" | "epoch_ns" | "yyyymmdd" | "string";

export interface SourceColumn {
  name: string;
  type: string;
}

export interface ColumnMapping {
  ts: string | null;
  tsKind: TsKind;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  symbol: string | null;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface MappingDetection {
  mapping: ColumnMapping;
  chartable: boolean;
  warnings: string[];
}

export type DatasetFormat = "csv" | "parquet" | "sample";

export interface RejectedRow {
  line: number | null;
  column: string | null;
  errorType: string;
  message: string;
  csvLine: string | null;
}

export interface DatasetInfo {
  /** Normalized OHLCV table name (also the dataset id). */
  name: string;
  /** Raw table holding the file exactly as parsed. */
  rawTable: string;
  sourceName: string;
  format: DatasetFormat;
  sizeBytes: number;
  rawRows: number;
  rows: number;
  columns: SourceColumn[];
  mapping: ColumnMapping;
  chartable: boolean;
  symbols: string[];
  start: number | null;
  end: number | null;
  /** Median spacing between bars of the first symbol, in seconds. */
  medianIntervalSec: number | null;
  duplicatesRemoved: number;
  nullRowsRemoved: number;
  outOfOrderRows: number;
  rejected: { count: number; samples: RejectedRow[] };
  warnings: string[];
  ingestMs: number;
  createdAt: number;
}

export type Timeframe = "auto" | "raw" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w" | "1M";

export const TIMEFRAME_SECONDS: Record<Exclude<Timeframe, "auto" | "raw">, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800,
  "1M": 2_629_746,
};

export type IndicatorSpec =
  | { type: "sma"; period: number }
  | { type: "ema"; period: number }
  | { type: "bbands"; period: number; mult: number }
  | { type: "vwap"; period: number }
  | { type: "rsi"; period: number }
  | { type: "macd"; fast: number; slow: number; signal: number }
  | { type: "atr"; period: number }
  | { type: "volatility"; period: number }
  | { type: "drawdown" };

export type IndicatorPane = "price" | "oscillator";

export interface IndicatorSeries {
  key: string;
  label: string;
  pane: IndicatorPane;
  /** Group used to put related oscillator series in the same pane (e.g. "macd"). */
  group: string;
  style: "line" | "histogram" | "band";
  values: Float64Array;
}

export interface BarsRequest {
  dataset: string;
  symbol?: string | null;
  timeframe: Timeframe;
  maxBars?: number;
  from?: number | null;
  to?: number | null;
  indicators?: IndicatorSpec[];
}

export interface BarsResult {
  dataset: string;
  symbol: string;
  timeframe: Exclude<Timeframe, "auto">;
  bucketSeconds: number | null;
  /** Unix seconds. */
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  indicators: IndicatorSeries[];
  sourceRows: number;
  queryMs: number;
  sql: string;
}

export type ColumnKind = "number" | "timestamp" | "date" | "boolean" | "string" | "other";

export interface ResultColumn {
  name: string;
  type: string;
  kind: ColumnKind;
  /** number/timestamp/date columns: Float64Array with NaN for NULL (timestamps in epoch ms). */
  numbers?: Float64Array;
  /** other columns: values with null for NULL. */
  values?: (string | boolean | null)[];
}

export interface QueryResult {
  columns: ResultColumn[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  statementCount: number;
  /** True when the script contained DDL/DML that may have changed the catalog. */
  mutatedCatalog: boolean;
}

export interface CatalogTable {
  name: string;
  kind: "table" | "view";
  rows: number | null;
  columns: SourceColumn[];
  dataset: boolean;
  internal: boolean;
}

export type StrategySpec =
  | { type: "buy_hold" }
  | { type: "sma_cross"; fast: number; slow: number }
  | { type: "ema_cross"; fast: number; slow: number }
  | { type: "rsi_reversion"; period: number; lower: number; upper: number }
  | { type: "bbands_breakout"; period: number; mult: number }
  | { type: "macd_trend"; fast: number; slow: number; signal: number }
  | { type: "custom_sql"; sql: string };

export interface BacktestRequest {
  dataset: string;
  symbol?: string | null;
  timeframe: Timeframe;
  strategy: StrategySpec;
  feeBps: number;
  slippageBps: number;
  allowShort: boolean;
  initialCapital: number;
  from?: number | null;
  to?: number | null;
}

export interface Trade {
  side: 1 | -1;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  bars: number;
  returnPct: number;
  open: boolean;
}

export interface BacktestMetrics {
  totalReturn: number;
  cagr: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  maxDrawdownDurationBars: number;
  calmar: number;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  exposure: number;
  turnover: number;
  finalEquity: number;
  periodsPerYear: number;
  bars: number;
}

export interface MonthlyReturn {
  year: number;
  month: number;
  ret: number;
}

export interface BacktestResult {
  dataset: string;
  symbol: string;
  timeframe: Exclude<Timeframe, "auto">;
  strategy: StrategySpec;
  metrics: BacktestMetrics;
  benchmark: BacktestMetrics;
  /** Down-sampled curves for plotting. */
  curve: { time: Float64Array; equity: Float64Array; benchmark: Float64Array; drawdown: Float64Array };
  trades: Trade[];
  tradesTruncated: boolean;
  monthly: MonthlyReturn[];
  returnHistogram: { binStart: number; binEnd: number; count: number }[];
  elapsedMs: number;
}

export type QualitySeverity = "error" | "warning" | "info";

export interface QualityIssue {
  id: string;
  severity: QualitySeverity;
  title: string;
  detail: string;
  count: number;
  examples: Record<string, string | number | null>[];
}

export interface QualityReport {
  dataset: string;
  score: number;
  rows: number;
  symbols: number;
  start: number | null;
  end: number | null;
  issues: QualityIssue[];
  elapsedMs: number;
}

export interface EngineInfo {
  duckdbVersion: string;
  bundle: string;
  persistence: "memory" | "opfs";
  persistenceError: string | null;
  bootMs: number;
  datasets: DatasetInfo[];
}

export interface EngineStats {
  memoryBytes: number;
  wasmHeapBytes: number | null;
  tables: number;
}
