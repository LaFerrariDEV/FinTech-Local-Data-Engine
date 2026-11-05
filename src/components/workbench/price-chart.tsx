"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import * as React from "react";
import { formatCompact, formatNumber, formatPct } from "@/lib/format";
import type { BarsResult, IndicatorSeries } from "@/lib/quant/types";

/** Fixed categorical order (validated for CVD separation and contrast on the panel surface). */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#9085e9", "#d55181", "#c98500", "#199e70"];
const UP = "#0ca30c";
const DOWN = "#d03b3b";

interface Props {
  bars: BarsResult;
  intraday: boolean;
}

interface LegendEntry {
  key: string;
  label: string;
  color: string;
  series: ISeriesApi<SeriesType>;
  values: Float64Array;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function lineData(time: Float64Array, values: Float64Array) {
  const out = new Array(time.length);
  for (let i = 0; i < time.length; i++) {
    const v = values[i];
    out[i] = Number.isFinite(v) ? { time: time[i] as UTCTimestamp, value: v } : { time: time[i] as UTCTimestamp };
  }
  return out;
}

/**
 * Canvas candlestick chart (TradingView Lightweight Charts) with volume, price overlays and
 * stacked oscillator panes. Data arrives as transferable Float64Arrays from the engine worker;
 * the legend is updated imperatively on crosshair moves so hovering never re-renders React.
 */
export function PriceChart({ bars, intraday }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const legendRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<SeriesType>[]>([]);
  const colorSlots = React.useRef(new Map<string, number>());
  const legendState = React.useRef<{ entries: LegendEntry[]; bars: BarsResult } | null>(null);

  const renderLegend = React.useCallback((index: number) => {
    const el = legendRef.current;
    const state = legendState.current;
    if (!el || !state || index < 0) return;
    const b = state.bars;
    const o = b.open[index];
    const c = b.close[index];
    const prev = index > 0 ? b.close[index - 1] : o;
    const change = prev ? c / prev - 1 : 0;
    const color = c >= o ? UP : DOWN;
    const parts = [
      `<span class="text-foreground font-semibold">${escapeHtml(b.symbol)}</span>`,
      `<span>O <b style="color:${color}">${formatNumber(o)}</b></span>`,
      `<span>H <b style="color:${color}">${formatNumber(b.high[index])}</b></span>`,
      `<span>L <b style="color:${color}">${formatNumber(b.low[index])}</b></span>`,
      `<span>C <b style="color:${color}">${formatNumber(c)}</b></span>`,
      `<span style="color:${change >= 0 ? UP : DOWN}">${formatPct(change, 2, true)}</span>`,
      `<span>V <b class="text-foreground">${formatCompact(b.volume[index])}</b></span>`,
    ];
    const ind = state.entries
      .map((e) => `<span><i style="display:inline-block;width:8px;height:2px;margin-right:4px;vertical-align:middle;background:${e.color}"></i>${escapeHtml(e.label)} <b class="text-foreground">${formatNumber(e.values[index])}</b></span>`)
      .join("");
    el.innerHTML = `<div class="flex flex-wrap gap-x-3">${parts.join("")}</div>${ind ? `<div class="mt-0.5 flex flex-wrap gap-x-3">${ind}</div>` : ""}`;
  }, []);

  // Create the chart once.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#101114" },
        textColor: "#8b909a",
        fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: "#23262c", separatorHoverColor: "#2f343c", enableResize: true },
      },
      grid: { vertLines: { color: "#16191d" }, horzLines: { color: "#16191d" } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#4b5059", labelBackgroundColor: "#23262c", style: LineStyle.Dashed, width: 1 },
        horzLine: { color: "#4b5059", labelBackgroundColor: "#23262c", style: LineStyle.Dashed, width: 1 },
      },
      rightPriceScale: { borderColor: "#23262c" },
      timeScale: { borderColor: "#23262c", rightOffset: 4, minBarSpacing: 0.05 },
      localization: { priceFormatter: (p: number) => formatNumber(p) },
    });
    chartRef.current = chart;
    const onMove = (param: MouseEventParams<Time>) => {
      const state = legendState.current;
      if (!state) return;
      let index = state.bars.time.length - 1;
      if (param.time != null) {
        const t = param.time as number;
        // Binary search the bar index for the hovered time.
        let lo = 0;
        let hi = state.bars.time.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (state.bars.time[mid] < t) lo = mid + 1;
          else hi = mid;
        }
        index = lo;
      }
      renderLegend(index);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
      legendState.current = null;
    };
  }, [renderLegend]);


  // (Re)build series whenever data changes.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    for (let i = chart.panes().length - 1; i > 0; i--) {
      try {
        chart.removePane(i);
      } catch {
        // Pane already removed with its last series.
      }
    }
    chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });

    const n = bars.time.length;
    // Dense charts: fainter volume so thousands of adjacent bars don't form a solid band over price.
    const volAlpha = n > 5000 ? 0.14 : n > 1500 ? 0.2 : 0.28;
    const volUp = `rgba(12,163,12,${volAlpha})`;
    const volDown = `rgba(208,59,59,${volAlpha})`;
    const candles = new Array(n);
    const volume = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = bars.time[i] as UTCTimestamp;
      candles[i] = { time: t, open: bars.open[i], high: bars.high[i], low: bars.low[i], close: bars.close[i] };
      volume[i] = { time: t, value: bars.volume[i], color: bars.close[i] >= bars.open[i] ? volUp : volDown };
    }
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineColor: "#4b5059",
    });
    candle.setData(candles);
    seriesRef.current.push(candle);
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: n > 5000 ? 0.88 : 0.82, bottom: 0 } });
    vol.setData(volume);
    seriesRef.current.push(vol);

    // Stable color per indicator group (color follows the entity, never its position).
    const slotFor = (group: string) => {
      const slots = colorSlots.current;
      if (!slots.has(group)) {
        const used = new Set(slots.values());
        let slot = 0;
        while (used.has(slot) && slot < SERIES_COLORS.length - 1) slot++;
        slots.set(group, slot);
      }
      return SERIES_COLORS[slots.get(group)! % SERIES_COLORS.length];
    };
    const activeGroups = new Set(bars.indicators.map((s) => s.group));
    for (const g of Array.from(colorSlots.current.keys())) if (!activeGroups.has(g)) colorSlots.current.delete(g);

    const entries: LegendEntry[] = [];
    const oscGroups: string[] = [];
    for (const s of bars.indicators) if (s.pane === "oscillator" && !oscGroups.includes(s.group)) oscGroups.push(s.group);

    const addIndicator = (s: IndicatorSeries, paneIndex: number, color: string, secondary: boolean) => {
      if (s.style === "histogram") {
        const data = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = s.values[i];
          data[i] = Number.isFinite(v) ? { time: bars.time[i] as UTCTimestamp, value: v, color: v >= 0 ? "rgba(12,163,12,0.55)" : "rgba(208,59,59,0.55)" } : { time: bars.time[i] as UTCTimestamp };
        }
        const h = chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, paneIndex);
        h.setData(data);
        seriesRef.current.push(h);
        entries.push({ key: s.key, label: s.label, color: "#8b909a", series: h, values: s.values });
        return;
      }
      const line = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: s.style === "band" && !s.key.endsWith("_mid") ? 1 : 2,
          lineStyle: secondary ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: s.style !== "band" || s.key.endsWith("_mid"),
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        },
        paneIndex,
      );
      line.setData(lineData(bars.time, s.values));
      seriesRef.current.push(line);
      entries.push({ key: s.key, label: s.label, color, series: line, values: s.values });
      if (s.key.startsWith("rsi_")) {
        for (const level of [30, 70]) line.createPriceLine({ price: level, color: "#4b5059", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "" });
      }
    };

    for (const s of bars.indicators) {
      const color = slotFor(s.group);
      if (s.pane === "price") {
        addIndicator(s, 0, color, false);
      } else {
        const paneIndex = 1 + oscGroups.indexOf(s.group);
        const isSecondary = s.key.endsWith("_signal");
        addIndicator(s, paneIndex, isSecondary ? SERIES_COLORS[(SERIES_COLORS.indexOf(color) + 1) % SERIES_COLORS.length] : color, false);
      }
    }
    const panes = chart.panes();
    panes.forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
    chart.timeScale().fitContent();
    legendState.current = { entries, bars };
    renderLegend(n - 1);
  }, [bars, intraday, renderLegend]);

  return (
    <div className="relative h-full w-full" data-testid="price-chart" data-bars={bars.time.length}>
      <div ref={containerRef} className="absolute inset-0" />
      <div
        ref={legendRef}
        data-testid="chart-legend"
        className="num pointer-events-none absolute left-2 top-1.5 z-10 max-w-[calc(100%-90px)] text-[11px] leading-5 text-muted-foreground"
      />
    </div>
  );
}
