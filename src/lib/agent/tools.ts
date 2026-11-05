import type { EngineClient } from "../engine/client";
import type { BacktestResult, DatasetInfo, IndicatorSpec, StrategySpec, Timeframe } from "../quant/types";
import type { ToolCall, ToolDefinition, ToolResult } from "./types";

/**
 * Tools exposed to the agent. Every tool executes inside the local engine worker; nothing
 * about the data leaves the browser except what the tool result itself contains.
 */

export interface AgentUiBridge {
  showChart(params: { dataset: string; symbol?: string | null; timeframe?: Timeframe; indicators?: IndicatorSpec[] }): void;
  showBacktest(result: BacktestResult): void;
}

export interface ToolContext {
  client: EngineClient;
  ui: AgentUiBridge;
  signal?: AbortSignal;
}

const TIMEFRAMES = ["auto", "raw", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"];

const indicatorSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["sma", "ema", "bbands", "vwap", "rsi", "macd", "atr", "volatility", "drawdown"] },
    period: { type: "integer", minimum: 1 },
    mult: { type: "number", description: "Bollinger band width in standard deviations" },
    fast: { type: "integer" },
    slow: { type: "integer" },
    signal: { type: "integer" },
  },
  required: ["type"],
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "list_datasets",
    description: "List the datasets loaded in the local DuckDB engine with row counts, symbols, date ranges and column mappings.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_table",
    description: "Return the columns and types of a table or view.",
    inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] },
  },
  {
    name: "run_sql",
    description:
      "Run a single read-only DuckDB SQL statement (SELECT/WITH/FROM/DESCRIBE/SUMMARIZE) against the local database and return up to max_rows rows. Write statements are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        max_rows: { type: "integer", minimum: 1, maximum: 500, description: "Default 50" },
      },
      required: ["sql"],
    },
  },
  {
    name: "compute_indicators",
    description:
      "Compute technical indicators on (optionally resampled) bars of one symbol and return the most recent values. Indicator types: sma, ema, bbands(period,mult), vwap, rsi, macd(fast,slow,signal), atr, volatility, drawdown.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        symbol: { type: "string" },
        timeframe: { type: "string", enum: TIMEFRAMES },
        indicators: { type: "array", items: indicatorSchema },
        last_n: { type: "integer", minimum: 1, maximum: 200, description: "Number of most recent bars to return (default 10)" },
      },
      required: ["dataset", "indicators"],
    },
  },
  {
    name: "run_backtest",
    description:
      "Run a vectorized, look-ahead-free backtest on one symbol. Strategies: buy_hold; sma_cross/ema_cross(fast,slow); rsi_reversion(period,lower,upper); bbands_breakout(period,mult); macd_trend(fast,slow,signal); custom_sql(sql) where sql selects columns ts and position (-1..1) from the CTE `bars`(ts, open, high, low, close, volume). The result is also shown in the Backtest tab.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        symbol: { type: "string" },
        timeframe: { type: "string", enum: TIMEFRAMES },
        strategy: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["buy_hold", "sma_cross", "ema_cross", "rsi_reversion", "bbands_breakout", "macd_trend", "custom_sql"] },
            fast: { type: "integer" },
            slow: { type: "integer" },
            signal: { type: "integer" },
            period: { type: "integer" },
            lower: { type: "number" },
            upper: { type: "number" },
            mult: { type: "number" },
            sql: { type: "string" },
          },
          required: ["type"],
        },
        fee_bps: { type: "number", minimum: 0 },
        slippage_bps: { type: "number", minimum: 0 },
        allow_short: { type: "boolean" },
      },
      required: ["dataset", "strategy"],
    },
  },
  {
    name: "data_quality",
    description: "Run the data-quality audit (OHLC consistency, bad prices, duplicates, gaps, outliers, stale runs) for a dataset.",
    inputSchema: { type: "object", properties: { dataset: { type: "string" } }, required: ["dataset"] },
  },
  {
    name: "show_chart",
    description: "Switch the user's chart to a dataset/symbol/timeframe and set the indicator overlays.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        symbol: { type: "string" },
        timeframe: { type: "string", enum: TIMEFRAMES },
        indicators: { type: "array", items: indicatorSchema },
      },
      required: ["dataset"],
    },
  },
];

const MAX_RESULT_CHARS = 12_000;

function round(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? null : String(value);
    return Math.abs(value) >= 1e-4 || value === 0 ? +value.toPrecision(8) : value;
  }
  return value;
}

function toJson(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => round(v));
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} chars]`;
}

function iso(seconds: number | null): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export function summarizeDataset(d: DatasetInfo) {
  return {
    name: d.name,
    raw_table: d.rawTable,
    source: d.sourceName,
    rows: d.rows,
    chartable: d.chartable,
    symbols: d.symbols.slice(0, 25),
    symbol_count: d.symbols.length,
    start: iso(d.start),
    end: iso(d.end),
    median_bar_seconds: d.medianIntervalSec,
    columns: d.chartable ? ["symbol", "ts", "open", "high", "low", "close", "volume"] : d.columns.map((c) => c.name),
    raw_columns: d.columns,
    mapping: d.mapping,
    warnings: d.warnings,
  };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

function timeframe(input: Record<string, unknown>): Timeframe {
  const tf = str(input, "timeframe");
  return tf && TIMEFRAMES.includes(tf) ? (tf as Timeframe) : "auto";
}

export function parseIndicators(value: unknown): IndicatorSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const type = String(r.type ?? "");
    switch (type) {
      case "sma":
      case "ema":
      case "vwap":
      case "atr":
        return { type, period: num(r, "period") ?? 20 } as IndicatorSpec;
      case "rsi":
        return { type, period: num(r, "period") ?? 14 };
      case "volatility":
        return { type, period: num(r, "period") ?? 20 };
      case "bbands":
        return { type, period: num(r, "period") ?? 20, mult: num(r, "mult") ?? 2 };
      case "macd":
        return { type, fast: num(r, "fast") ?? 12, slow: num(r, "slow") ?? 26, signal: num(r, "signal") ?? 9 };
      case "drawdown":
        return { type };
      default:
        throw new Error(`Unknown indicator type "${type}"`);
    }
  });
}

export function parseStrategy(value: unknown): StrategySpec {
  const r = (value ?? {}) as Record<string, unknown>;
  const type = String(r.type ?? "");
  switch (type) {
    case "buy_hold":
      return { type };
    case "sma_cross":
    case "ema_cross":
      return { type, fast: num(r, "fast") ?? 20, slow: num(r, "slow") ?? 50 };
    case "rsi_reversion":
      return { type, period: num(r, "period") ?? 14, lower: num(r, "lower") ?? 30, upper: num(r, "upper") ?? 70 };
    case "bbands_breakout":
      return { type, period: num(r, "period") ?? 20, mult: num(r, "mult") ?? 2 };
    case "macd_trend":
      return { type, fast: num(r, "fast") ?? 12, slow: num(r, "slow") ?? 26, signal: num(r, "signal") ?? 9 };
    case "custom_sql":
      return { type, sql: String(r.sql ?? "") };
    default:
      throw new Error(`Unknown strategy type "${type}"`);
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const base = { toolCallId: call.id, name: call.name };
  if (call.parseError) return { ...base, content: call.parseError, isError: true };
  const input = call.input ?? {};
  const opts = { signal: ctx.signal };
  try {
    switch (call.name) {
      case "list_datasets": {
        const datasets = await ctx.client.call("datasets", {} as never, opts);
        return { ...base, content: toJson(datasets.map(summarizeDataset)), isError: false };
      }
      case "describe_table": {
        const table = str(input, "table");
        if (!table) throw new Error("table is required");
        const r = await ctx.client.call("agentQuery", { sql: `DESCRIBE "${table.replace(/"/g, '""')}"`, maxRows: 500 }, opts);
        return { ...base, content: toJson(r.rows.map((row) => ({ column: row.column_name, type: row.column_type }))), isError: false };
      }
      case "run_sql": {
        const sql = str(input, "sql");
        if (!sql) throw new Error("sql is required");
        const maxRows = Math.min(500, Math.max(1, Math.floor(num(input, "max_rows") ?? 50)));
        const r = await ctx.client.call("agentQuery", { sql, maxRows }, opts);
        return { ...base, content: toJson({ columns: r.columns, rows: r.rows, row_count: r.rows.length, truncated: r.truncated, elapsed_ms: r.elapsedMs }), isError: false };
      }
      case "compute_indicators": {
        const dataset = str(input, "dataset");
        if (!dataset) throw new Error("dataset is required");
        const indicators = parseIndicators(input.indicators);
        const lastN = Math.min(200, Math.max(1, Math.floor(num(input, "last_n") ?? 10)));
        const bars = await ctx.client.call("bars", { dataset, symbol: str(input, "symbol"), timeframe: timeframe(input), indicators, maxBars: 20_000 }, opts);
        const n = bars.time.length;
        const start = Math.max(0, n - lastN);
        const rows = [];
        for (let i = start; i < n; i++) {
          const row: Record<string, unknown> = { time: iso(bars.time[i]), open: bars.open[i], high: bars.high[i], low: bars.low[i], close: bars.close[i], volume: bars.volume[i] };
          for (const s of bars.indicators) row[s.key] = s.values[i];
          rows.push(row);
        }
        return { ...base, content: toJson({ dataset: bars.dataset, symbol: bars.symbol, timeframe: bars.timeframe, bars: n, rows }), isError: false };
      }
      case "run_backtest": {
        const dataset = str(input, "dataset");
        if (!dataset) throw new Error("dataset is required");
        const result = await ctx.client.call(
          "backtest",
          {
            dataset,
            symbol: str(input, "symbol"),
            timeframe: timeframe(input),
            strategy: parseStrategy(input.strategy),
            feeBps: num(input, "fee_bps") ?? 1,
            slippageBps: num(input, "slippage_bps") ?? 1,
            allowShort: input.allow_short === true,
            initialCapital: 100_000,
          },
          opts,
        );
        ctx.ui.showBacktest(result);
        return {
          ...base,
          content: toJson({
            dataset: result.dataset,
            symbol: result.symbol,
            timeframe: result.timeframe,
            strategy: result.strategy,
            metrics: result.metrics,
            buy_and_hold: result.benchmark,
            recent_trades: result.trades.slice(-10).map((t) => ({ ...t, entryTime: iso(t.entryTime), exitTime: iso(t.exitTime) })),
          }),
          isError: false,
        };
      }
      case "data_quality": {
        const dataset = str(input, "dataset");
        if (!dataset) throw new Error("dataset is required");
        const report = await ctx.client.call("quality", { dataset }, opts);
        return {
          ...base,
          content: toJson({ score: report.score, rows: report.rows, issues: report.issues.map((i) => ({ severity: i.severity, title: i.title, count: i.count, detail: i.detail, examples: i.examples.slice(0, 3) })) }),
          isError: false,
        };
      }
      case "show_chart": {
        const dataset = str(input, "dataset");
        if (!dataset) throw new Error("dataset is required");
        const datasets = await ctx.client.call("datasets", {} as never, opts);
        const ds = datasets.find((d) => d.name === dataset);
        if (!ds) throw new Error(`Unknown dataset "${dataset}". Available: ${datasets.map((d) => d.name).join(", ") || "none"}`);
        const indicators = input.indicators === undefined ? undefined : parseIndicators(input.indicators);
        ctx.ui.showChart({ dataset, symbol: str(input, "symbol") ?? null, timeframe: str(input, "timeframe") ? timeframe(input) : undefined, indicators });
        return { ...base, content: toJson({ ok: true, dataset, symbol: str(input, "symbol") ?? ds.symbols[0] ?? null }), isError: false };
      }
      default:
        return { ...base, content: `Unknown tool "${call.name}"`, isError: true };
    }
  } catch (error) {
    return { ...base, content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
