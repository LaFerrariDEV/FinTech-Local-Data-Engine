/**
 * Recursive indicator kernels operating on Float64Array columns. These run inside the engine
 * worker after DuckDB has produced the bars, since recursive filters (EMA, Wilder smoothing)
 * are O(n) in a tight loop but awkward and slow to express in SQL.
 *
 * Conventions: outputs have the same length as inputs; warm-up values are NaN.
 */

export function sma(values: Float64Array, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > period) {
      sum -= values[i - period];
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` valid values. */
export function ema(values: Float64Array, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  const alpha = 2 / (period + 1);
  let start = 0;
  while (start < values.length && Number.isNaN(values[start])) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      out[i] = prev;
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(close: Float64Array, period: number): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(Number.NaN);
  if (n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const value = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = value(avgGain, avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = value(avgGain, avgLoss);
  }
  return out;
}

export function macd(close: Float64Array, fast: number, slow: number, signal: number) {
  const fastEma = ema(close, fast);
  const slowEma = ema(close, slow);
  const line = new Float64Array(close.length);
  for (let i = 0; i < close.length; i++) line[i] = fastEma[i] - slowEma[i];
  const signalLine = ema(line, signal);
  const hist = new Float64Array(close.length);
  for (let i = 0; i < close.length; i++) hist[i] = line[i] - signalLine[i];
  return { line, signal: signalLine, hist };
}

/** Wilder's Average True Range. */
export function atr(high: Float64Array, low: Float64Array, close: Float64Array, period: number): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(Number.NaN);
  if (n < period) return out;
  const tr = new Float64Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    const pc = close[i - 1];
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rollingStd(values: Float64Array, period: number, sample = false): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(Number.NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean) * (sample ? period / (period - 1) : 1);
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

/**
 * Largest-Triangle-Three-Buckets down-sampling. Keeps the visual shape of dense line series
 * (equity curves, indicators) while reducing the number of points sent to the UI thread.
 */
export function lttb(x: Float64Array, y: Float64Array, threshold: number): { x: Float64Array; y: Float64Array; index: Uint32Array } {
  const n = x.length;
  if (threshold >= n || threshold < 3) {
    const index = new Uint32Array(n);
    for (let i = 0; i < n; i++) index[i] = i;
    return { x: x.slice(), y: y.slice(), index };
  }
  const index = new Uint32Array(threshold);
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0;
  index[0] = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const avgLen = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += x[j];
      avgY += y[j];
    }
    avgX /= avgLen || 1;
    avgY /= avgLen || 1;
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const ax = x[a];
    const ay = y[a];
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * (y[j] - ay) - (ax - x[j]) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    index[i + 1] = next;
    a = next;
  }
  index[threshold - 1] = n - 1;
  const outX = new Float64Array(threshold);
  const outY = new Float64Array(threshold);
  for (let i = 0; i < threshold; i++) {
    outX[i] = x[index[i]];
    outY[i] = y[index[i]];
  }
  return { x: outX, y: outY, index };
}

/** Picks values at the given indices (used to keep auxiliary series aligned with LTTB output). */
export function take(values: Float64Array, index: Uint32Array): Float64Array {
  const out = new Float64Array(index.length);
  for (let i = 0; i < index.length; i++) out[i] = values[index[i]];
  return out;
}
