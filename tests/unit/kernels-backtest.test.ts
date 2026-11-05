import { describe, expect, it } from "vitest";
import { computeMetrics, monthlyReturns, returnHistogram, simulate, strategyTargets, validateStrategy } from "../../src/lib/quant/backtest";
import { atr, ema, lttb, macd, rsi, sma } from "../../src/lib/quant/kernels";

const arr = (...v: number[]) => Float64Array.from(v);

describe("kernels", () => {
  it("sma", () => {
    expect(Array.from(sma(arr(1, 2, 3, 4, 5), 3))).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it("ema seeds with the SMA and follows the recursion", () => {
    const out = ema(arr(1, 2, 3, 4, 5), 3);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(0.5 * 4 + 0.5 * 2);
    expect(out[4]).toBe(0.5 * 5 + 0.5 * 3);
  });

  it("rsi is 100 for monotonic gains and 50 for flat series", () => {
    expect(rsi(arr(1, 2, 3, 4, 5, 6), 3)[5]).toBe(100);
    expect(rsi(arr(5, 5, 5, 5, 5), 3)[4]).toBe(50);
    const r = rsi(Float64Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 3) * 5), 14);
    for (let i = 14; i < 100; i++) {
      expect(r[i]).toBeGreaterThanOrEqual(0);
      expect(r[i]).toBeLessThanOrEqual(100);
    }
  });

  it("macd histogram equals line minus signal", () => {
    const close = Float64Array.from({ length: 80 }, (_, i) => 100 + i * 0.3 + Math.sin(i));
    const m = macd(close, 12, 26, 9);
    for (let i = 40; i < 80; i++) expect(m.hist[i]).toBeCloseTo(m.line[i] - m.signal[i], 12);
  });

  it("atr uses true range with gaps", () => {
    const out = atr(arr(10, 12, 15), arr(9, 11, 13), arr(9.5, 11.5, 14), 2);
    // TR = [1, max(1, 2.5, 1.5)=2.5, max(2, 3.5, 1.5)=3.5]; ATR1 = 1.75; ATR2 = (1.75 + 3.5) / 2
    expect(out[1]).toBe(1.75);
    expect(out[2]).toBe((1.75 + 3.5) / 2);
  });

  it("lttb keeps endpoints, extremes and size", () => {
    const n = 10_000;
    const x = Float64Array.from({ length: n }, (_, i) => i);
    const y = Float64Array.from({ length: n }, (_, i) => (i === 5000 ? 1000 : Math.sin(i / 100)));
    const out = lttb(x, y, 500);
    expect(out.x.length).toBe(500);
    expect(out.x[0]).toBe(0);
    expect(out.x[499]).toBe(n - 1);
    expect(Array.from(out.y)).toContain(1000);
    for (let i = 1; i < 500; i++) expect(out.x[i]).toBeGreaterThan(out.x[i - 1]);
  });
});

describe("backtest simulator", () => {
  const time = Float64Array.from({ length: 6 }, (_, i) => 1_700_000_000 + i * 86_400);
  const close = arr(100, 110, 99, 99, 108.9, 108.9);

  it("has no look-ahead: a signal on bar i earns bar i+1's return", () => {
    const target = arr(0, 1, 0, 0, 0, 0); // decided at close of bar 1 → held over bar 2 only
    const sim = simulate({ time, close, target, costBps: 0, initialCapital: 100 });
    expect(sim.returns[1]).toBe(0);
    expect(sim.returns[2]).toBeCloseTo(99 / 110 - 1, 12);
    expect(sim.returns[3]).toBe(0);
    expect(sim.trades).toHaveLength(1);
    expect(sim.trades[0]).toMatchObject({ side: 1, entryPrice: 110, exitPrice: 99, bars: 1, open: false });
  });

  it("charges costs on turnover", () => {
    const target = arr(1, 1, 1, 1, 1, 1);
    const free = simulate({ time, close, target, costBps: 0, initialCapital: 100 });
    const costly = simulate({ time, close, target, costBps: 100, initialCapital: 100 });
    // The entry cost (1%) is charged on bar 1, when the position is opened: 100 * (1 + 10% - 1%).
    expect(costly.equity[1]).toBeCloseTo(109, 10);
    expect(free.equity[5] / costly.equity[5]).toBeCloseTo(110 / 109, 10);
    expect(costly.turnover).toBe(1);
  });

  it("supports short positions", () => {
    const sim = simulate({ time, close, target: arr(-1, -1, 0, 0, 0, 0), costBps: 0, initialCapital: 100 });
    expect(sim.returns[1]).toBeCloseTo(-(110 / 100 - 1), 12);
    expect(sim.returns[2]).toBeCloseTo(-(99 / 110 - 1), 12);
    expect(sim.trades[0].side).toBe(-1);
  });

  it("computes metrics consistently", () => {
    const sim = simulate({ time, close, target: arr(1, 1, 1, 1, 1, 1), costBps: 0, initialCapital: 100 });
    const m = computeMetrics(sim, time, 100);
    expect(m.totalReturn).toBeCloseTo(108.9 / 100 - 1, 12);
    expect(m.maxDrawdown).toBeCloseTo(99 / 110 - 1, 12);
    expect(m.exposure).toBe(1);
    expect(m.trades).toBe(1);
    expect(m.winRate).toBe(1);
  });

  it("builds monthly returns that compound to the total", () => {
    const n = 400;
    const t = Float64Array.from({ length: n }, (_, i) => Date.UTC(2020, 0, 1) / 1000 + i * 86_400);
    const eq = Float64Array.from({ length: n }, (_, i) => 100 * Math.exp(0.001 * i + 0.02 * Math.sin(i / 10)));
    const months = monthlyReturns(t, eq);
    expect(months[0]).toMatchObject({ year: 2020, month: 1 });
    const compounded = months.reduce((acc, m) => acc * (1 + m.ret), 1);
    expect(compounded).toBeCloseTo(eq[n - 1] / eq[0], 10);
  });

  it("histogram bins cover all clipped returns", () => {
    const r = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i) / 100);
    const h = returnHistogram(r, 20);
    expect(h).toHaveLength(20);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(999);
  });

  it("generates bounded targets for every built-in strategy", () => {
    const c = Float64Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 15) + i * 0.05);
    for (const spec of [
      { type: "buy_hold" },
      { type: "sma_cross", fast: 5, slow: 20 },
      { type: "ema_cross", fast: 5, slow: 20 },
      { type: "rsi_reversion", period: 14, lower: 30, upper: 70 },
      { type: "bbands_breakout", period: 20, mult: 2 },
      { type: "macd_trend", fast: 12, slow: 26, signal: 9 },
    ] as const) {
      const long = strategyTargets(spec, c, false);
      const short = strategyTargets(spec, c, true);
      for (const v of long) expect([0, 1]).toContain(v);
      for (const v of short) expect([-1, 0, 1]).toContain(v);
    }
  });

  it("validates strategy parameters", () => {
    expect(() => validateStrategy({ type: "sma_cross", fast: 50, slow: 20 })).toThrow(/shorter/);
    expect(() => validateStrategy({ type: "rsi_reversion", period: 14, lower: 80, upper: 20 })).toThrow();
    expect(() => validateStrategy({ type: "custom_sql", sql: "  " })).toThrow(/empty/);
  });
});
