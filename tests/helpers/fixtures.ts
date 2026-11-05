/** Deterministic synthetic market data for tests. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface Bar {
  t: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function makeBars(count: number, seed = 7, startSec = Date.UTC(2020, 0, 1) / 1000, stepSec = 86_400, p0 = 100): Bar[] {
  const rand = mulberry32(seed);
  const bars: Bar[] = [];
  let prev = p0;
  for (let i = 0; i < count; i++) {
    const r = 0.0003 + 0.015 * gaussian(rand);
    const close = prev * Math.exp(r);
    const open = prev * Math.exp(0.002 * gaussian(rand));
    const high = Math.max(open, close) * (1 + Math.abs(0.004 * gaussian(rand)));
    const low = Math.min(open, close) * (1 - Math.abs(0.004 * gaussian(rand)));
    const volume = Math.round(1_000_000 * Math.exp(0.3 * gaussian(rand)));
    bars.push({
      t: startSec + i * stepSec,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
    prev = close;
  }
  return bars;
}

function round(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function isoDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function isoDateTime(t: number): string {
  return new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function barsToCsv(bars: Bar[], options: { symbol?: string; header?: string; intraday?: boolean } = {}): string {
  const header = options.header ?? (options.symbol ? "Date,Symbol,Open,High,Low,Close,Volume" : "Date,Open,High,Low,Close,Volume");
  const lines = [header];
  for (const b of bars) {
    const date = options.intraday ? isoDateTime(b.t) : isoDate(b.t);
    lines.push(
      options.symbol
        ? `${date},${options.symbol},${b.open},${b.high},${b.low},${b.close},${b.volume}`
        : `${date},${b.open},${b.high},${b.low},${b.close},${b.volume}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export const encoder = new TextEncoder();
