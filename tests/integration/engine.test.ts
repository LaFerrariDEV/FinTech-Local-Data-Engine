import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineCore } from "../../src/lib/engine/core";
import { EngineError } from "../../src/lib/engine/driver";
import { atr, ema, rollingStd, rsi, sma } from "../../src/lib/quant/kernels";
import { barsToCsv, encoder, isoDate, makeBars } from "../helpers/fixtures";
import { createNodeEngine } from "../helpers/node-driver";

let engine: EngineCore;

beforeAll(async () => {
  engine = await createNodeEngine();
});

afterAll(async () => {
  await engine?.close();
});

function src(fileName: string, text: string | Uint8Array) {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  return { fileName, size: bytes.byteLength, bytes };
}

const closeTo = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

describe("boot", () => {
  it("runs DuckDB WASM and exposes a version", async () => {
    const version = await engine.version();
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
    const r = await engine.runQuery("SELECT 42 AS answer");
    expect(r.columns[0].numbers?.[0]).toBe(42);
  });

  it("init is idempotent", async () => {
    await expect(engine.init()).resolves.toBeInstanceOf(Array);
  });
});

describe("CSV ingestion", () => {
  it("loads a standard OHLCV file and detects the mapping", async () => {
    const bars = makeBars(500);
    const ds = await engine.ingest(src("SPY Daily.csv", barsToCsv(bars)));
    expect(ds.name).toBe("spy_daily");
    expect(ds.rawRows).toBe(500);
    expect(ds.rows).toBe(500);
    expect(ds.chartable).toBe(true);
    expect(ds.mapping).toMatchObject({ ts: "Date", open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume", tsKind: "native" });
    expect(ds.start).toBe(bars[0].t);
    expect(ds.end).toBe(bars[499].t);
    expect(ds.medianIntervalSec).toBe(86_400);
    expect(ds.rejected.count).toBe(0);
  });

  it("keeps very long lines and quoted multi-line fields intact (no dropped rows)", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const lines = ["date,close,note"];
    const expectedLengths: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const d = isoDate(Date.UTC(2010, 0, 1) / 1000 + i * 86_400);
      let note: string;
      if (i % 250 === 3) note = huge; // 5 MB single field
      else if (i % 7 === 0) note = `"multi\nline, with ""quotes"" and, commas"`;
      else note = `n${i}`;
      lines.push(`${d},${100 + i},${note}`);
      expectedLengths.push(note === huge ? huge.length : note.startsWith('"') ? 'multi\nline, with "quotes" and, commas'.length : note.length);
    }
    const ds = await engine.ingest(src("long_lines.csv", `${lines.join("\n")}\n`));
    expect(ds.rawRows).toBe(1000);
    expect(ds.rows).toBe(1000);
    const r = await engine.runQuery(`SELECT length(note) AS len FROM long_lines_raw ORDER BY rowid`, 2000);
    expect(Array.from(r.columns[0].numbers!)).toEqual(expectedLengths);
  });

  it("ingests 1,000,000 rows without losing a single row", async () => {
    const n = 1_000_000;
    const parts: string[] = ["ts,price,qty"];
    let qtySum = 0;
    const t0 = Date.UTC(2023, 0, 1) / 1000;
    for (let i = 0; i < n; i++) {
      const qty = (i % 97) + 1;
      qtySum += qty;
      parts.push(`${(t0 + i * 60) * 1000},${(100 + Math.sin(i / 1000) * 5).toFixed(4)},${qty}`);
    }
    const started = performance.now();
    const ds = await engine.ingest(src("ticks_1m.csv", parts.join("\n")));
    const ms = performance.now() - started;
    expect(ds.rawRows).toBe(n);
    expect(ds.rows).toBe(n);
    expect(ds.mapping.tsKind).toBe("epoch_ms");
    expect(ds.mapping.close).toBe("price");
    expect(ds.mapping.volume).toBe("qty");
    const sum = await engine.runQuery("SELECT sum(volume) AS s, count(*) AS c FROM ticks_1m");
    expect(sum.columns[0].numbers![0]).toBe(qtySum);
    expect(sum.columns[1].numbers![0]).toBe(n);
    expect(ms).toBeLessThan(60_000);
    await engine.dropDataset(ds.name);
  });

  it("rejects malformed CSV in strict mode and quarantines rows in lenient mode", async () => {
    const text = "date,open,high,low,close\n2024-01-01,1,2,0.5,1.5\n2024-01-02,1,2,0.5,1.6,EXTRA\n2024-01-03,1,2,0.5,1.7\n2024-01-04,1,2,0.5,1.8\n";
    let caught: unknown;
    try {
      await engine.ingest(src("broken.csv", text));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("MALFORMED_CSV");
    // Failed imports leave nothing behind.
    const tables = await engine.catalog();
    expect(tables.some((t) => t.name.startsWith("broken"))).toBe(false);

    const ds = await engine.ingest(src("broken.csv", text), { lenient: true });
    expect(ds.rawRows).toBe(3);
    expect(ds.rejected.count).toBe(1);
    expect(ds.rejected.samples[0].line).toBe(3);
    expect(ds.rejected.samples[0].errorType).toMatch(/TOO MANY COLUMNS/);
    expect(ds.warnings.join(" ")).toMatch(/quarantined/);
  });

  it("recovers from late type changes with a full-file type scan instead of dropping rows", async () => {
    const lines = ["date,close"];
    for (let i = 0; i < 30_000; i++) lines.push(`${isoDate(Date.UTC(1950, 0, 1) / 1000 + i * 86_400)},${100 + (i % 10)}`);
    lines.push("2032-02-20,N/A");
    const ds = await engine.ingest(src("late_type.csv", lines.join("\n")));
    expect(ds.rawRows).toBe(30_001);
    expect(ds.rows).toBe(30_000);
    expect(ds.nullRowsRemoved).toBe(1);
  });

  it("rejects empty files", async () => {
    await expect(engine.ingest({ fileName: "empty.csv", size: 0, bytes: new Uint8Array() })).rejects.toMatchObject({ code: "EMPTY_FILE" });
  });

  it("handles header-only CSV files", async () => {
    const ds = await engine.ingest(src("header_only.csv", "date,open,high,low,close,volume\n"));
    expect(ds.rawRows).toBe(0);
    expect(ds.chartable).toBe(false);
  });

  it("parses alternative timestamp encodings and formatted numbers", async () => {
    const yyyymmdd = await engine.ingest(src("ints.csv", "trade_date;px_last;vol\n20240102;1234.5;10\n20240103;1300;20\n"));
    expect(yyyymmdd.mapping.tsKind).toBe("yyyymmdd");
    expect(yyyymmdd.rows).toBe(2);
    const r1 = await engine.runQuery(`SELECT strftime(ts, '%Y-%m-%d') AS d, close FROM ints ORDER BY ts`);
    expect(r1.columns[0].values).toEqual(["2024-01-02", "2024-01-03"]);
    expect(Array.from(r1.columns[1].numbers!)).toEqual([1234.5, 1300]);

    const epochS = await engine.ingest(src("epoch_s.csv", "time,close\n1704067200,10\n1704153600,11\n"));
    expect(epochS.mapping.tsKind).toBe("epoch_s");
    expect(epochS.start).toBe(1704067200);

    const us = await engine.ingest(src("us_dates.csv", 'Date,Close/Last,Volume\n01/03/2024,"$1,250.75",100\n01/04/2024,"$1,260.00",200\n'));
    expect(us.mapping.tsKind === "string" || us.mapping.tsKind === "native").toBe(true);
    expect(us.rows).toBe(2);
    const r2 = await engine.runQuery(`SELECT close FROM us_dates ORDER BY ts`);
    expect(Array.from(r2.columns[0].numbers!)).toEqual([1250.75, 1260]);
  });

  it("supports long-format multi-symbol files, duplicates and unsorted input", async () => {
    const a = makeBars(100, 1);
    const b = makeBars(80, 2, undefined, undefined, 50);
    const rows = [
      ...a.map((x) => `${isoDate(x.t)},AAA,${x.open},${x.high},${x.low},${x.close},${x.volume}`),
      ...b.map((x) => `${isoDate(x.t)},BBB,${x.open},${x.high},${x.low},${x.close},${x.volume}`),
    ].reverse();
    rows.push(`${isoDate(a[10].t)},AAA,1,1,1,1,1`); // duplicate timestamp (last wins)
    const ds = await engine.ingest(src("multi.csv", `date,ticker,open,high,low,close,volume\n${rows.join("\n")}\n`));
    expect(ds.symbols).toEqual(["AAA", "BBB"]);
    expect(ds.rows).toBe(180);
    expect(ds.duplicatesRemoved).toBe(1);
    expect(ds.outOfOrderRows).toBeGreaterThan(0);
    const r = await engine.runQuery(`SELECT close FROM multi WHERE symbol = 'AAA' AND ts = TIMESTAMP '${isoDate(a[10].t)}'`);
    expect(r.columns[0].numbers![0]).toBe(1);
    const bars = await engine.bars({ dataset: "multi", symbol: "BBB", timeframe: "raw" });
    expect(bars.time.length).toBe(80);
    expect(bars.close[0]).toBe(b[0].close);
  });

  it("keeps non-financial files queryable without a mapping", async () => {
    const ds = await engine.ingest(src("people.csv", "name,age\nann,31\nbob,42\n"));
    expect(ds.chartable).toBe(false);
    const r = await engine.runQuery(`SELECT sum(age) AS s FROM people`);
    expect(r.columns[0].numbers![0]).toBe(73);
    await expect(engine.bars({ dataset: "people", timeframe: "auto" })).rejects.toMatchObject({ code: "NOT_CHARTABLE" });
    const remapped = await engine.remap("people", { ts: null, tsKind: "native", open: null, high: null, low: null, close: "age", volume: null, symbol: null }).catch((e) => e);
    expect(remapped).toBeInstanceOf(EngineError);
  });
});

describe("Parquet round trip", () => {
  it("exports a dataset to Parquet and re-imports it losslessly", async () => {
    const out = await engine.exportData({ table: "spy_daily", format: "parquet" });
    expect(out.bytes.byteLength).toBeGreaterThan(100);
    expect(String.fromCharCode(...out.bytes.subarray(0, 4))).toBe("PAR1");
    const ds = await engine.ingest({ fileName: "spy_roundtrip.parquet", size: out.bytes.byteLength, bytes: out.bytes });
    expect(ds.format).toBe("parquet");
    expect(ds.rows).toBe(500);
    expect(ds.mapping.ts).toBe("ts");
    const diff = await engine.runQuery(
      `SELECT count(*) AS n FROM spy_daily a JOIN spy_roundtrip b USING (ts) WHERE a.close = b.close AND a.high = b.high AND a.volume = b.volume`,
    );
    expect(diff.columns[0].numbers![0]).toBe(500);
  });

  it("exports CSV", async () => {
    const out = await engine.exportData({ sql: "SELECT * FROM spy_daily LIMIT 10", format: "csv" });
    const text = new TextDecoder().decode(out.bytes);
    expect(text.split("\n")[0]).toBe("symbol,ts,open,high,low,close,volume");
    expect(out.rows).toBe(10);
  });

  it("rejects corrupt parquet", async () => {
    const bytes = encoder.encode("PAR1 this is not parquet PAR1");
    await expect(engine.ingest({ fileName: "corrupt.parquet", size: bytes.byteLength, bytes })).rejects.toMatchObject({ code: "MALFORMED_PARQUET" });
  });
});

describe("bars, resampling and indicators", () => {
  it("computes SQL indicators that match reference kernels", async () => {
    const res = await engine.bars({
      dataset: "spy_daily",
      timeframe: "raw",
      indicators: [
        { type: "sma", period: 20 },
        { type: "bbands", period: 20, mult: 2 },
        { type: "ema", period: 12 },
        { type: "rsi", period: 14 },
        { type: "macd", fast: 12, slow: 26, signal: 9 },
        { type: "atr", period: 14 },
        { type: "vwap", period: 10 },
        { type: "volatility", period: 20 },
        { type: "drawdown" },
      ],
    });
    expect(res.time.length).toBe(500);
    const find = (key: string) => res.indicators.find((s) => s.key === key)!.values;
    const refSma = sma(res.close, 20);
    const refSd = rollingStd(res.close, 20);
    const sqlSma = find("sma_20");
    const upper = find("bb_20_2_upper");
    for (let i = 0; i < 500; i++) {
      if (Number.isNaN(refSma[i])) {
        expect(Number.isNaN(sqlSma[i])).toBe(true);
        continue;
      }
      expect(closeTo(sqlSma[i], refSma[i], 1e-9)).toBe(true);
      expect(closeTo(upper[i], refSma[i] + 2 * refSd[i], 1e-7)).toBe(true);
    }
    expect(Array.from(find("ema_12"))).toEqual(Array.from(ema(res.close, 12)));
    expect(Array.from(find("rsi_14"))).toEqual(Array.from(rsi(res.close, 14)));
    expect(Array.from(find("atr_14"))).toEqual(Array.from(atr(res.high, res.low, res.close, 14)));
    expect(res.indicators.filter((s) => s.group === "macd_12_26_9")).toHaveLength(3);
    const vwap = find("vwap_10");
    let num = 0;
    let den = 0;
    for (let i = 490; i < 500; i++) {
      num += ((res.high[i] + res.low[i] + res.close[i]) / 3) * res.volume[i];
      den += res.volume[i];
    }
    expect(closeTo(vwap[499], num / den, 1e-9)).toBe(true);
    const dd = find("drawdown");
    expect(Math.max(...Array.from(dd))).toBeLessThanOrEqual(0);
    expect(Number.isFinite(find("volatility_20")[499])).toBe(true);
  });

  it("resamples to weekly candles with correct OHLC aggregation", async () => {
    const raw = await engine.bars({ dataset: "spy_daily", timeframe: "raw" });
    const weekly = await engine.bars({ dataset: "spy_daily", timeframe: "1w" });
    // Reference aggregation in JS (weeks start Monday 00:00 UTC).
    const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
    for (let i = 0; i < raw.time.length; i++) {
      const t = raw.time[i];
      const day = Math.floor(t / 86_400);
      const monday = (day - ((day + 3) % 7)) * 86_400; // 1970-01-01 was a Thursday
      const b = buckets.get(monday);
      if (!b) buckets.set(monday, { o: raw.open[i], h: raw.high[i], l: raw.low[i], c: raw.close[i], v: raw.volume[i] });
      else {
        b.h = Math.max(b.h, raw.high[i]);
        b.l = Math.min(b.l, raw.low[i]);
        b.c = raw.close[i];
        b.v += raw.volume[i];
      }
    }
    expect(weekly.time.length).toBe(buckets.size);
    const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
    keys.forEach((k, i) => {
      const b = buckets.get(k)!;
      expect(weekly.time[i]).toBe(k);
      expect(weekly.open[i]).toBe(b.o);
      expect(weekly.high[i]).toBe(b.h);
      expect(weekly.low[i]).toBe(b.l);
      expect(weekly.close[i]).toBe(b.c);
      expect(weekly.volume[i]).toBe(b.v);
    });
  });

  it("auto timeframe keeps the bar count under maxBars", async () => {
    const ds = await engine.generateSample({ kind: "intraday", bars: 200_000 });
    expect(ds.rows).toBe(400_000);
    expect(ds.symbols).toEqual(["BTCX", "ETHX"]);
    const res = await engine.bars({ dataset: ds.name, timeframe: "auto", maxBars: 5000 });
    expect(res.time.length).toBeLessThanOrEqual(5000);
    expect(res.timeframe).not.toBe("raw");
    for (let i = 1; i < res.time.length; i++) expect(res.time[i]).toBeGreaterThan(res.time[i - 1]);
    for (let i = 0; i < res.time.length; i++) {
      expect(res.high[i]).toBeGreaterThanOrEqual(Math.max(res.open[i], res.close[i]) - 1e-9);
      expect(res.low[i]).toBeLessThanOrEqual(Math.min(res.open[i], res.close[i]) + 1e-9);
    }
    await engine.dropDataset(ds.name);
  });

  it("supports range filters", async () => {
    const all = await engine.bars({ dataset: "spy_daily", timeframe: "raw" });
    const part = await engine.bars({ dataset: "spy_daily", timeframe: "raw", from: all.time[100], to: all.time[199] });
    expect(part.time.length).toBe(100);
    expect(part.time[0]).toBe(all.time[100]);
  });

  it("validates indicator parameters", async () => {
    await expect(engine.bars({ dataset: "spy_daily", timeframe: "raw", indicators: [{ type: "sma", period: 0 }] })).rejects.toThrow(/period/);
    await expect(
      engine.bars({ dataset: "spy_daily", timeframe: "raw", indicators: [{ type: "sma", period: "1; DROP TABLE x" as unknown as number }] }),
    ).rejects.toThrow(/period/);
  });
});

describe("backtesting", () => {
  it("buy & hold matches the raw price return", async () => {
    const res = await engine.backtest({
      dataset: "spy_daily",
      timeframe: "raw",
      strategy: { type: "buy_hold" },
      feeBps: 0,
      slippageBps: 0,
      allowShort: false,
      initialCapital: 10_000,
    });
    const bars = await engine.bars({ dataset: "spy_daily", timeframe: "raw" });
    // Position is entered at the close of bar 0, so the return is close[n-1]/close[0]-1.
    expect(closeTo(res.metrics.totalReturn, bars.close[499] / bars.close[0] - 1, 1e-9)).toBe(true);
    expect(closeTo(res.metrics.totalReturn, res.benchmark.totalReturn, 1e-12)).toBe(true);
    expect(res.metrics.trades).toBe(1);
  });

  it("custom SQL signals reproduce the built-in SMA crossover exactly", async () => {
    const base = { dataset: "spy_daily", timeframe: "raw" as const, feeBps: 5, slippageBps: 2, allowShort: false, initialCapital: 100_000 };
    const builtin = await engine.backtest({ ...base, strategy: { type: "sma_cross", fast: 10, slow: 30 } });
    const custom = await engine.backtest({
      ...base,
      strategy: {
        type: "custom_sql",
        sql: `SELECT ts,
                CASE WHEN count(*) OVER (ORDER BY ts ROWS 29 PRECEDING) >= 30
                      AND avg(close) OVER (ORDER BY ts ROWS 9 PRECEDING) > avg(close) OVER (ORDER BY ts ROWS 29 PRECEDING)
                     THEN 1 ELSE 0 END AS position
              FROM bars`,
      },
    });
    expect(builtin.metrics.trades).toBeGreaterThan(3);
    expect(custom.metrics.trades).toBe(builtin.metrics.trades);
    expect(closeTo(custom.metrics.totalReturn, builtin.metrics.totalReturn, 1e-9)).toBe(true);
    expect(closeTo(custom.metrics.sharpe, builtin.metrics.sharpe, 1e-9)).toBe(true);
  });

  it("rejects custom SQL that tries to write", async () => {
    await expect(
      engine.backtest({
        dataset: "spy_daily",
        timeframe: "raw",
        strategy: { type: "custom_sql", sql: "DROP TABLE spy_daily" },
        feeBps: 0,
        slippageBps: 0,
        allowShort: false,
        initialCapital: 1,
      }),
    ).rejects.toThrow(/Rejected SQL/);
    const r = await engine.runQuery("SELECT count(*) AS n FROM spy_daily");
    expect(r.columns[0].numbers![0]).toBe(500);
  });

  it("produces consistent analytics for every built-in strategy", async () => {
    const strategies = [
      { type: "ema_cross", fast: 12, slow: 26 },
      { type: "rsi_reversion", period: 14, lower: 30, upper: 70 },
      { type: "bbands_breakout", period: 20, mult: 2 },
      { type: "macd_trend", fast: 12, slow: 26, signal: 9 },
    ] as const;
    for (const strategy of strategies) {
      const res = await engine.backtest({ dataset: "spy_daily", timeframe: "raw", strategy, feeBps: 1, slippageBps: 1, allowShort: true, initialCapital: 1000 });
      expect(res.curve.time.length).toBe(500);
      expect(res.metrics.maxDrawdown).toBeLessThanOrEqual(0);
      expect(res.metrics.exposure).toBeGreaterThanOrEqual(0);
      expect(res.metrics.exposure).toBeLessThanOrEqual(1);
      const compounded = res.monthly.reduce((acc, m) => acc * (1 + m.ret), 1) - 1;
      expect(closeTo(compounded, res.metrics.totalReturn, 1e-9)).toBe(true);
    }
  });
});

describe("data quality", () => {
  it("flags OHLC violations, bad prices, outliers and stale runs", async () => {
    const bars = makeBars(300, 11);
    const lines = ["date,open,high,low,close,volume"];
    bars.forEach((b, i) => {
      let { open, high, low, close } = b;
      let volume = b.volume;
      if (i === 50) [high, low] = [low - 1, high + 1]; // high < low
      if (i === 60) close = -5;
      if (i === 70) volume = -100;
      if (i === 150) close = b.close * 30; // outlier spike
      if (i >= 200 && i < 215) close = 123.45; // stale run
      if (i >= 200 && i < 215) {
        open = 123.45;
        high = 124;
        low = 123;
      }
      lines.push(`${isoDate(b.t)},${open},${high},${low},${close},${volume}`);
    });
    const ds = await engine.ingest(src("dirty.csv", lines.join("\n")));
    const q = await engine.quality(ds.name);
    const ids = q.issues.map((i) => i.id);
    expect(ids).toContain("ohlc_violation");
    expect(ids).toContain("non_positive");
    expect(ids).toContain("negative_volume");
    expect(ids).toContain("return_outliers");
    expect(ids).toContain("stale_prices");
    expect(q.score).toBeLessThan(80);
    const clean = await engine.quality("spy_daily");
    expect(clean.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(clean.score).toBeGreaterThan(q.score);
  });
});

describe("SQL console and agent guard", () => {
  it("runs scripts, truncates large results and reports catalog mutations", async () => {
    const r = await engine.runQuery("CREATE TABLE tmp_numbers AS SELECT range AS i FROM range(100000); SELECT * FROM tmp_numbers", 1000);
    expect(r.statementCount).toBe(2);
    expect(r.mutatedCatalog).toBe(true);
    expect(r.rowCount).toBe(1000);
    expect(r.truncated).toBe(true);
    // The connection is still healthy after an early-terminated stream.
    const after = await engine.runQuery("SELECT count(*) AS n FROM tmp_numbers");
    expect(after.columns[0].numbers![0]).toBe(100_000);
    await engine.runQuery("DROP TABLE tmp_numbers");
  });

  it("returns typed columns", async () => {
    const r = await engine.runQuery("SELECT 1.5 AS d, 2::BIGINT AS b, 'x' AS s, TRUE AS t, TIMESTAMP '2024-01-01 00:00:00' AS ts, NULL::DOUBLE AS n, [1,2] AS l");
    const kinds = Object.fromEntries(r.columns.map((c) => [c.name, c.kind]));
    expect(kinds).toEqual({ d: "number", b: "number", s: "string", t: "boolean", ts: "timestamp", n: "number", l: "other" });
    expect(r.columns.find((c) => c.name === "ts")!.numbers![0]).toBe(Date.UTC(2024, 0, 1));
    expect(Number.isNaN(r.columns.find((c) => c.name === "n")!.numbers![0])).toBe(true);
    expect(r.columns.find((c) => c.name === "l")!.values![0]).toBe("[1,2]");
  });

  it("surfaces SQL errors as QUERY_FAILED", async () => {
    await expect(engine.runQuery("SELECT * FROM does_not_exist")).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("dropping a dataset table from SQL updates the registry", async () => {
    await engine.ingest(src("ephemeral.csv", barsToCsv(makeBars(10))));
    expect(engine.listDatasets().some((d) => d.name === "ephemeral")).toBe(true);
    await engine.runQuery("DROP TABLE ephemeral");
    expect(engine.listDatasets().some((d) => d.name === "ephemeral")).toBe(false);
  });

  it("agent queries are read-only and capped", async () => {
    const ok = await engine.agentQuery("SELECT * FROM spy_daily", 5);
    expect(ok.rows).toHaveLength(5);
    expect(ok.truncated).toBe(true);
    await expect(engine.agentQuery("DELETE FROM spy_daily")).rejects.toThrow(/Rejected SQL/);
    await expect(engine.agentQuery("SELECT 1; DROP TABLE spy_daily")).rejects.toThrow(/single statement/);
    const describe = await engine.agentQuery("DESCRIBE spy_daily");
    expect(describe.rows.length).toBe(7);
  });

  it("lists the catalog with dataset flags", async () => {
    const cat = await engine.catalog();
    const spy = cat.find((t) => t.name === "spy_daily")!;
    expect(spy.dataset).toBe(true);
    expect(spy.columns.map((c) => c.name)).toEqual(["symbol", "ts", "open", "high", "low", "close", "volume"]);
    expect(cat.find((t) => t.name === "__qa_datasets")?.internal).toBe(true);
  });
});

describe("remapping and samples", () => {
  it("re-normalizes with a user-provided mapping", async () => {
    await engine.ingest(src("odd.csv", "when,a,b\n2024-01-01,10,1\n2024-01-02,11,2\n2024-01-03,12,3\n"));
    const ds = await engine.remap("odd", { ts: "when", tsKind: "native", open: null, high: null, low: null, close: "a", volume: "b", symbol: null });
    expect(ds.chartable).toBe(true);
    expect(ds.rows).toBe(3);
    const bars = await engine.bars({ dataset: "odd", timeframe: "raw" });
    expect(Array.from(bars.close)).toEqual([10, 11, 12]);
    expect(Array.from(bars.volume)).toEqual([1, 2, 3]);
  });

  it("generates daily sample data", async () => {
    const ds = await engine.generateSample({ kind: "daily", bars: 1000 });
    expect(ds.rows).toBe(3000);
    expect(ds.symbols).toEqual(["ACME", "GLOBX", "INITECH"]);
    const q = await engine.quality(ds.name);
    expect(q.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("resource stability", () => {
  it("repeated load/drop cycles do not leak tables or DuckDB memory", async () => {
    const csv = barsToCsv(makeBars(20_000, 5));
    const before = await engine.stats();
    for (let i = 0; i < 15; i++) {
      const ds = await engine.ingest(src("cycle.csv", csv));
      await engine.bars({ dataset: ds.name, timeframe: "auto", indicators: [{ type: "sma", period: 20 }, { type: "rsi", period: 14 }] });
      await engine.dropDataset(ds.name);
    }
    const after = await engine.stats();
    expect(after.tables).toBe(before.tables);
    expect(after.memoryBytes).toBeLessThanOrEqual(before.memoryBytes + 8 * 1024 * 1024);
  });
});
