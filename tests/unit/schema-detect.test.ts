import { describe, expect, it } from "vitest";
import { detectMapping, inferEpochKind, validateMapping } from "../../src/lib/quant/schema-detect";
import { resolveTimeframe, timestampExpr, buildBarsQuery, indicatorKey, validateIndicator } from "../../src/lib/quant/ohlcv-sql";

const cols = (spec: string) =>
  spec.split(",").map((pair) => {
    const [name, type] = pair.split(":");
    return { name, type };
  });

describe("detectMapping", () => {
  it("maps a Yahoo-style export, preferring Close over Adj Close", () => {
    const d = detectMapping(cols("Date:DATE,Open:DOUBLE,High:DOUBLE,Low:DOUBLE,Close:DOUBLE,Adj Close:DOUBLE,Volume:BIGINT"));
    expect(d.mapping).toMatchObject({ ts: "Date", open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume", tsKind: "native" });
    expect(d.chartable).toBe(true);
  });

  it("maps Binance klines with epoch milliseconds", () => {
    const d = detectMapping(cols("open_time:BIGINT,open:DOUBLE,high:DOUBLE,low:DOUBLE,close:DOUBLE,volume:DOUBLE,close_time:BIGINT,quote_volume:DOUBLE"), {
      open_time: { min: 1.6e12, max: 1.7e12 },
    });
    expect(d.mapping.ts).toBe("open_time");
    expect(d.mapping.tsKind).toBe("epoch_ms");
    expect(d.mapping.close).toBe("close");
  });

  it("maps long-format files with a ticker column and odd names", () => {
    const d = detectMapping(cols("TRADE_DATE:VARCHAR,TICKER:VARCHAR,PX_LAST:VARCHAR,PX_VOLUME:BIGINT"));
    expect(d.mapping).toMatchObject({ ts: "TRADE_DATE", tsKind: "string", symbol: "TICKER", close: "PX_LAST" });
  });

  it("falls back to a single numeric column as price", () => {
    const d = detectMapping(cols("day:DATE,SPY:DOUBLE"));
    expect(d.mapping.close).toBe("SPY");
    expect(d.warnings.join(" ")).toMatch(/close price/);
  });

  it("reports non-financial files as not chartable", () => {
    const d = detectMapping(cols("name:VARCHAR,age:BIGINT,city:VARCHAR"));
    expect(d.chartable).toBe(false);
  });

  it("uses a temporal column even when its name is unusual", () => {
    const d = detectMapping(cols("bucket:TIMESTAMP,price:DOUBLE"));
    expect(d.mapping.ts).toBe("bucket");
    expect(d.mapping.close).toBe("price");
  });
});

describe("inferEpochKind", () => {
  it("distinguishes units and YYYYMMDD integers", () => {
    expect(inferEpochKind({ min: 1.6e9, max: 1.7e9 })).toBe("epoch_s");
    expect(inferEpochKind({ min: 1.6e12, max: 1.7e12 })).toBe("epoch_ms");
    expect(inferEpochKind({ min: 1.6e15, max: 1.7e15 })).toBe("epoch_us");
    expect(inferEpochKind({ min: 1.6e18, max: 1.7e18 })).toBe("epoch_ns");
    expect(inferEpochKind({ min: 20200101, max: 20241231 })).toBe("yyyymmdd");
  });
});

describe("validateMapping", () => {
  it("flags missing, unknown and duplicate columns", () => {
    const c = cols("a:DATE,b:DOUBLE");
    expect(validateMapping({ ts: "a", tsKind: "native", open: null, high: null, low: null, close: "b", volume: null, symbol: null }, c)).toEqual([]);
    const errors = validateMapping({ ts: "a", tsKind: "native", open: "b", high: null, low: null, close: "b", volume: "zzz", symbol: null }, c);
    expect(errors.join(" ")).toMatch(/both open and close/);
    expect(errors.join(" ")).toMatch(/"zzz"/);
    expect(validateMapping({ ts: null, tsKind: "native", open: null, high: null, low: null, close: null, volume: null, symbol: null }, c)).toHaveLength(2);
  });
});

describe("SQL builders", () => {
  it("builds timestamp expressions per encoding", () => {
    expect(timestampExpr("t", "epoch_ms")).toContain("* 1000");
    expect(timestampExpr("t", "yyyymmdd")).toContain("%Y%m%d");
    expect(timestampExpr('we"ird', "native")).toBe('CAST("we""ird" AS TIMESTAMP)');
  });

  it("chooses the smallest timeframe that fits under maxBars", () => {
    const year = 365 * 86_400;
    expect(resolveTimeframe("auto", year, 1000, 86_400, 5000)).toBe("raw");
    expect(resolveTimeframe("auto", year, 525_600, 60, 20_000)).toBe("30m");
    expect(resolveTimeframe("auto", 10 * year, 3_000_000, 60, 5000)).toBe("1d");
    expect(resolveTimeframe("1h", year, 10, 60, 5000)).toBe("1h");
  });

  it("keeps indicator keys stable and validates parameters", () => {
    expect(indicatorKey({ type: "bbands", period: 20, mult: 2.5 })).toBe("bb_20_2p5");
    expect(() => validateIndicator({ type: "macd", fast: 26, slow: 12, signal: 9 })).toThrow(/shorter/);
    expect(() => validateIndicator({ type: "rsi", period: 1 })).toThrow();
    const { sql, aliases } = buildBarsQuery({ table: "t", symbol: "A'B", timeframe: "1d" }, [{ type: "sma", period: 5 }, { type: "ema", period: 5 }]);
    expect(aliases).toEqual(["sma_5"]);
    expect(sql).toContain("symbol = 'A''B'");
    expect(sql).toContain("time_bucket(INTERVAL '86400 seconds', ts)");
  });
});
