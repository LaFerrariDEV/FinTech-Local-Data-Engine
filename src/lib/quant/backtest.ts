import { ema, lttb, macd, rsi, sma, take } from "./kernels";
import { assertFinite, assertInt } from "./sql";
import type { BacktestMetrics, MonthlyReturn, StrategySpec, Trade } from "./types";

/**
 * Vectorized single-asset backtester.
 *
 * Timing model (no look-ahead): a target position decided at the close of bar i is held over
 * bar i+1, i.e. held[i] = target[i-1]. The bar return of the strategy is
 *   r[i] = held[i] * (close[i] / close[i-1] - 1) - cost * |held[i] - held[i-1]|
 * where cost = (fee + slippage) in decimal, charged on turnover when the trade is executed at
 * the close of bar i-1.
 */

export function validateStrategy(spec: StrategySpec): StrategySpec {
  switch (spec.type) {
    case "buy_hold":
      break;
    case "sma_cross":
    case "ema_cross":
      assertInt(spec.fast, "fast period", 1, 2000);
      assertInt(spec.slow, "slow period", 2, 5000);
      if (spec.fast >= spec.slow) throw new RangeError("fast period must be shorter than slow period");
      break;
    case "rsi_reversion":
      assertInt(spec.period, "RSI period", 2, 1000);
      assertFinite(spec.lower, "lower threshold", 0, 100);
      assertFinite(spec.upper, "upper threshold", 0, 100);
      if (spec.lower >= spec.upper) throw new RangeError("lower threshold must be below upper threshold");
      break;
    case "bbands_breakout":
      assertInt(spec.period, "Bollinger period", 2, 2000);
      assertFinite(spec.mult, "Bollinger multiplier", 0.1, 10);
      break;
    case "macd_trend":
      assertInt(spec.fast, "MACD fast", 1, 1000);
      assertInt(spec.slow, "MACD slow", 2, 2000);
      assertInt(spec.signal, "MACD signal", 1, 1000);
      if (spec.fast >= spec.slow) throw new RangeError("MACD fast must be shorter than slow");
      break;
    case "custom_sql":
      if (typeof spec.sql !== "string" || !spec.sql.trim()) throw new RangeError("Custom strategy SQL is empty");
      break;
    default:
      throw new RangeError(`Unknown strategy ${(spec as { type: string }).type}`);
  }
  return spec;
}

/** Target positions in {-1, 0, 1} decided at each bar's close. */
export function strategyTargets(
  spec: Exclude<StrategySpec, { type: "custom_sql" }>,
  close: Float64Array,
  allowShort: boolean,
): Float64Array {
  const n = close.length;
  const target = new Float64Array(n);
  const flatOrShort = allowShort ? -1 : 0;
  switch (spec.type) {
    case "buy_hold":
      target.fill(1);
      break;
    case "sma_cross":
    case "ema_cross": {
      const f = spec.type === "sma_cross" ? sma(close, spec.fast) : ema(close, spec.fast);
      const s = spec.type === "sma_cross" ? sma(close, spec.slow) : ema(close, spec.slow);
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(f[i]) || Number.isNaN(s[i])) target[i] = 0;
        else target[i] = f[i] > s[i] ? 1 : flatOrShort;
      }
      break;
    }
    case "rsi_reversion": {
      const r = rsi(close, spec.period);
      let pos = 0;
      for (let i = 0; i < n; i++) {
        const v = r[i];
        if (!Number.isNaN(v)) {
          if (pos <= 0 && v < spec.lower) pos = 1;
          else if (pos === 1 && v > spec.upper) pos = allowShort ? -1 : 0;
          else if (pos === -1 && v < spec.lower) pos = 1;
          else if (allowShort && pos === 0 && v > spec.upper) pos = -1;
        }
        target[i] = pos;
      }
      break;
    }
    case "bbands_breakout": {
      const mid = sma(close, spec.period);
      let pos = 0;
      // Rolling population std, matching the SQL Bollinger definition.
      const p = spec.period;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        sum += close[i];
        sumSq += close[i] * close[i];
        if (i >= p) {
          sum -= close[i - p];
          sumSq -= close[i - p] * close[i - p];
        }
        if (i >= p - 1) {
          const m = mid[i];
          const sd = Math.sqrt(Math.max(0, sumSq / p - (sum / p) * (sum / p)));
          const upper = m + spec.mult * sd;
          const lower = m - spec.mult * sd;
          if (close[i] > upper) pos = 1;
          else if (close[i] < lower) pos = allowShort ? -1 : 0;
          else if (pos === 1 && close[i] < m) pos = 0;
          else if (pos === -1 && close[i] > m) pos = 0;
        }
        target[i] = pos;
      }
      break;
    }
    case "macd_trend": {
      const m = macd(close, spec.fast, spec.slow, spec.signal);
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(m.line[i]) || Number.isNaN(m.signal[i])) target[i] = 0;
        else target[i] = m.line[i] > m.signal[i] ? 1 : flatOrShort;
      }
      break;
    }
  }
  return target;
}

/** Clamps arbitrary custom signal values into [-1, 1] (or [0, 1] without shorting); NaN -> flat. */
export function sanitizeTargets(raw: Float64Array, allowShort: boolean): Float64Array {
  const out = new Float64Array(raw.length);
  const min = allowShort ? -1 : 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    out[i] = Number.isFinite(v) ? Math.max(min, Math.min(1, v)) : 0;
  }
  return out;
}

export interface SimulationInput {
  time: Float64Array; // unix seconds
  close: Float64Array;
  target: Float64Array;
  costBps: number;
  initialCapital: number;
}

export interface Simulation {
  equity: Float64Array;
  returns: Float64Array;
  held: Float64Array;
  drawdown: Float64Array;
  trades: Trade[];
  turnover: number;
}

export function simulate({ time, close, target, costBps, initialCapital }: SimulationInput): Simulation {
  const n = close.length;
  const equity = new Float64Array(n);
  const returns = new Float64Array(n);
  const held = new Float64Array(n);
  const drawdown = new Float64Array(n);
  const trades: Trade[] = [];
  const cost = costBps / 10_000;
  let turnover = 0;
  if (n === 0) return { equity, returns, held, drawdown, trades, turnover };

  equity[0] = initialCapital;
  let peak = initialCapital;
  let openTrade: { side: 1 | -1; entryIndex: number; entryPrice: number; size: number; costPaid: number } | null = null;

  const closeTrade = (exitIndex: number, isOpen: boolean) => {
    if (!openTrade) return;
    const exitPrice = close[exitIndex];
    const gross = openTrade.side * (exitPrice / openTrade.entryPrice - 1);
    const exitCost = isOpen ? 0 : cost;
    trades.push({
      side: openTrade.side,
      entryTime: time[openTrade.entryIndex],
      entryPrice: openTrade.entryPrice,
      exitTime: time[exitIndex],
      exitPrice,
      bars: exitIndex - openTrade.entryIndex,
      returnPct: gross * openTrade.size - openTrade.costPaid - exitCost * openTrade.size,
      open: isOpen,
    });
    openTrade = null;
  };

  for (let i = 1; i < n; i++) {
    const h = target[i - 1];
    const prevHeld = held[i - 1];
    held[i] = h;
    const change = Math.abs(h - prevHeld);
    turnover += change;
    const priceRet = close[i - 1] !== 0 ? close[i] / close[i - 1] - 1 : 0;
    const r = h * priceRet - cost * change;
    returns[i] = r;
    equity[i] = equity[i - 1] * (1 + r);
    if (equity[i] > peak) peak = equity[i];
    drawdown[i] = peak > 0 ? equity[i] / peak - 1 : 0;

    // Trade bookkeeping happens at bar i-1's close, where the position change was executed.
    const sign = Math.sign(h) as -1 | 0 | 1;
    const prevSign = Math.sign(prevHeld) as -1 | 0 | 1;
    if (sign !== prevSign) {
      if (openTrade) closeTrade(i - 1, false);
      if (sign !== 0) openTrade = { side: sign, entryIndex: i - 1, entryPrice: close[i - 1], size: Math.abs(h), costPaid: cost * change };
    }
  }
  if (openTrade) closeTrade(n - 1, true);
  return { equity, returns, held, drawdown, trades, turnover };
}

export function periodsPerYear(time: Float64Array): number {
  const n = time.length;
  if (n < 2) return 252;
  const years = (time[n - 1] - time[0]) / (365.25 * 86_400);
  if (years <= 0) return 252;
  return (n - 1) / years;
}

export function computeMetrics(sim: Simulation, time: Float64Array, initialCapital: number): BacktestMetrics {
  const n = sim.equity.length;
  const ppy = periodsPerYear(time);
  const finalEquity = n ? sim.equity[n - 1] : initialCapital;
  const totalReturn = finalEquity / initialCapital - 1;
  const years = n > 1 ? (time[n - 1] - time[0]) / (365.25 * 86_400) : 0;
  const cagr = years > 0 && finalEquity > 0 ? Math.pow(finalEquity / initialCapital, 1 / years) - 1 : totalReturn;

  let mean = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    mean += sim.returns[i];
    count++;
  }
  mean = count ? mean / count : 0;
  let variance = 0;
  let downside = 0;
  for (let i = 1; i < n; i++) {
    const d = sim.returns[i] - mean;
    variance += d * d;
    if (sim.returns[i] < 0) downside += sim.returns[i] * sim.returns[i];
  }
  const std = count > 1 ? Math.sqrt(variance / (count - 1)) : 0;
  const downDev = count > 0 ? Math.sqrt(downside / count) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(ppy) : 0;
  const sortino = downDev > 0 ? (mean / downDev) * Math.sqrt(ppy) : 0;

  let maxDd = 0;
  let ddStart = 0;
  let maxDur = 0;
  let inDd = false;
  for (let i = 0; i < n; i++) {
    const dd = sim.drawdown[i];
    if (dd < maxDd) maxDd = dd;
    if (dd < 0 && !inDd) {
      inDd = true;
      ddStart = i;
    } else if (dd >= 0 && inDd) {
      inDd = false;
      maxDur = Math.max(maxDur, i - ddStart);
    }
  }
  if (inDd) maxDur = Math.max(maxDur, n - ddStart);

  const closed = sim.trades;
  const wins = closed.filter((t) => t.returnPct > 0);
  const losses = closed.filter((t) => t.returnPct <= 0);
  const sumWins = wins.reduce((a, t) => a + t.returnPct, 0);
  const sumLosses = losses.reduce((a, t) => a + t.returnPct, 0);
  let exposed = 0;
  for (let i = 1; i < n; i++) if (sim.held[i] !== 0) exposed++;

  return {
    totalReturn,
    cagr,
    volatility: std * Math.sqrt(ppy),
    sharpe,
    sortino,
    maxDrawdown: maxDd,
    maxDrawdownDurationBars: maxDur,
    calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : 0,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgWin: wins.length ? sumWins / wins.length : 0,
    avgLoss: losses.length ? sumLosses / losses.length : 0,
    profitFactor: sumLosses < 0 ? sumWins / Math.abs(sumLosses) : wins.length ? Number.POSITIVE_INFINITY : 0,
    exposure: n > 1 ? exposed / (n - 1) : 0,
    turnover: sim.turnover,
    finalEquity,
    periodsPerYear: ppy,
    bars: n,
  };
}

export function monthlyReturns(time: Float64Array, equity: Float64Array): MonthlyReturn[] {
  const out: MonthlyReturn[] = [];
  if (equity.length < 2) return out;
  let startEquity = equity[0];
  let cur = new Date(time[0] * 1000);
  let key = cur.getUTCFullYear() * 12 + cur.getUTCMonth();
  for (let i = 1; i < equity.length; i++) {
    const d = new Date(time[i] * 1000);
    const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (k !== key) {
      out.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1, ret: equity[i - 1] / startEquity - 1 });
      startEquity = equity[i - 1];
      key = k;
    }
    cur = d;
  }
  out.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1, ret: equity[equity.length - 1] / startEquity - 1 });
  return out;
}

export function returnHistogram(returns: Float64Array, bins = 40): { binStart: number; binEnd: number; count: number }[] {
  const values: number[] = [];
  for (let i = 1; i < returns.length; i++) if (returns[i] !== 0 && Number.isFinite(returns[i])) values.push(returns[i]);
  if (values.length === 0) return [];
  values.sort((a, b) => a - b);
  // Clip to the 0.5%..99.5% range so a single outlier does not flatten the histogram.
  const lo = values[Math.floor(values.length * 0.005)];
  const hi = values[Math.min(values.length - 1, Math.ceil(values.length * 0.995) - 1)];
  const width = (hi - lo) / bins || 1e-9;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)));
    counts[idx]++;
  }
  return counts.map((count, i) => ({ binStart: lo + i * width, binEnd: lo + (i + 1) * width, count }));
}

export function downsampleCurves(
  time: Float64Array,
  equity: Float64Array,
  benchmark: Float64Array,
  drawdown: Float64Array,
  maxPoints: number,
) {
  if (time.length <= maxPoints) {
    return { time: time.slice(), equity: equity.slice(), benchmark: benchmark.slice(), drawdown: drawdown.slice() };
  }
  const sampled = lttb(time, equity, maxPoints);
  return {
    time: sampled.x,
    equity: sampled.y,
    benchmark: take(benchmark, sampled.index),
    drawdown: take(drawdown, sampled.index),
  };
}
