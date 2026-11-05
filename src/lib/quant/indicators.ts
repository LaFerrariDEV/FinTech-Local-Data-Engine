import { atr, ema, macd, rsi } from "./kernels";
import { indicatorKey, isSqlIndicator } from "./ohlcv-sql";
import type { IndicatorSeries, IndicatorSpec } from "./types";

export interface OhlcColumns {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

export function indicatorLabel(spec: IndicatorSpec): string {
  switch (spec.type) {
    case "sma":
      return `SMA ${spec.period}`;
    case "ema":
      return `EMA ${spec.period}`;
    case "bbands":
      return `BB ${spec.period}, ${spec.mult}`;
    case "vwap":
      return `VWAP ${spec.period}`;
    case "rsi":
      return `RSI ${spec.period}`;
    case "macd":
      return `MACD ${spec.fast}/${spec.slow}/${spec.signal}`;
    case "atr":
      return `ATR ${spec.period}`;
    case "volatility":
      return `Vol ${spec.period}`;
    case "drawdown":
      return "Drawdown";
  }
}

/**
 * Maps SQL output columns (aliases) and kernel outputs into uniform IndicatorSeries.
 * `sqlColumns` holds the Float64Array for each SQL alias returned by the bars query.
 */
export function assembleIndicators(
  specs: IndicatorSpec[],
  bars: OhlcColumns,
  sqlColumns: Record<string, Float64Array>,
): IndicatorSeries[] {
  const out: IndicatorSeries[] = [];
  for (const spec of specs) {
    const key = indicatorKey(spec);
    const label = indicatorLabel(spec);
    if (isSqlIndicator(spec)) {
      if (spec.type === "bbands") {
        for (const part of ["upper", "mid", "lower"] as const) {
          const values = sqlColumns[`${key}_${part}`];
          if (values) out.push({ key: `${key}_${part}`, label: `${label} ${part}`, pane: "price", group: key, style: "band", values });
        }
        continue;
      }
      const values = sqlColumns[key];
      if (!values) continue;
      const pane = spec.type === "volatility" || spec.type === "drawdown" ? "oscillator" : "price";
      out.push({ key, label, pane, group: key, style: "line", values });
      continue;
    }
    switch (spec.type) {
      case "ema":
        out.push({ key, label, pane: "price", group: key, style: "line", values: ema(bars.close, spec.period) });
        break;
      case "rsi":
        out.push({ key, label, pane: "oscillator", group: key, style: "line", values: rsi(bars.close, spec.period) });
        break;
      case "atr":
        out.push({ key, label, pane: "oscillator", group: key, style: "line", values: atr(bars.high, bars.low, bars.close, spec.period) });
        break;
      case "macd": {
        const m = macd(bars.close, spec.fast, spec.slow, spec.signal);
        out.push({ key: `${key}_line`, label, pane: "oscillator", group: key, style: "line", values: m.line });
        out.push({ key: `${key}_signal`, label: "Signal", pane: "oscillator", group: key, style: "line", values: m.signal });
        out.push({ key: `${key}_hist`, label: "Hist", pane: "oscillator", group: key, style: "histogram", values: m.hist });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export const DEFAULT_INDICATORS: IndicatorSpec[] = [
  { type: "sma", period: 20 },
  { type: "sma", period: 50 },
];

export const INDICATOR_PRESETS: { label: string; spec: IndicatorSpec }[] = [
  { label: "SMA 20", spec: { type: "sma", period: 20 } },
  { label: "SMA 50", spec: { type: "sma", period: 50 } },
  { label: "SMA 200", spec: { type: "sma", period: 200 } },
  { label: "EMA 12", spec: { type: "ema", period: 12 } },
  { label: "EMA 26", spec: { type: "ema", period: 26 } },
  { label: "Bollinger 20, 2", spec: { type: "bbands", period: 20, mult: 2 } },
  { label: "VWAP 20", spec: { type: "vwap", period: 20 } },
  { label: "RSI 14", spec: { type: "rsi", period: 14 } },
  { label: "MACD 12/26/9", spec: { type: "macd", fast: 12, slow: 26, signal: 9 } },
  { label: "ATR 14", spec: { type: "atr", period: 14 } },
  { label: "Volatility 20", spec: { type: "volatility", period: 20 } },
  { label: "Drawdown", spec: { type: "drawdown" } },
];
