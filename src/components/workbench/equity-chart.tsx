"use client";

import { AreaSeries, ColorType, createChart, CrosshairMode, LineSeries, LineStyle, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import * as React from "react";
import { formatNumber, formatPct } from "@/lib/format";
import type { BacktestResult } from "@/lib/quant/types";

const STRATEGY = "#3987e5";
const BENCH = "#d95926";

/** Strategy equity vs buy & hold (one shared axis, both indexed to the same capital) plus a drawdown pane. */
export function EquityChart({ result }: { result: BacktestResult }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const legend = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#101114" },
        textColor: "#8b909a",
        fontSize: 11,
        fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
        attributionLogo: false,
        panes: { separatorColor: "#23262c" },
      },
      grid: { vertLines: { color: "#16191d" }, horzLines: { color: "#16191d" } },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderColor: "#23262c" },
      timeScale: { borderColor: "#23262c", minBarSpacing: 0.01, timeVisible: result.timeframe !== "1d" && result.timeframe !== "1w" && result.timeframe !== "1M" },
      localization: { priceFormatter: (p: number) => formatNumber(p, 2) },
    });
    const { time, equity, benchmark, drawdown } = result.curve;
    const toLine = (values: Float64Array) => Array.from(time, (t, i) => ({ time: t as UTCTimestamp, value: values[i] }));
    const strat = chart.addSeries(LineSeries, { color: STRATEGY, lineWidth: 2, priceLineVisible: false, title: "Strategy" });
    strat.setData(toLine(equity));
    const bench = chart.addSeries(LineSeries, { color: BENCH, lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: "Buy & hold" });
    bench.setData(toLine(benchmark));
    const dd = chart.addSeries(
      AreaSeries,
      { lineColor: "#d03b3b", topColor: "rgba(208,59,59,0.05)", bottomColor: "rgba(208,59,59,0.35)", lineWidth: 1, priceLineVisible: false, priceFormat: { type: "percent" } },
      1,
    );
    dd.setData(Array.from(time, (t, i) => ({ time: t as UTCTimestamp, value: drawdown[i] * 100 })));
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1);
    chart.timeScale().fitContent();
    const update = (index: number) => {
      if (!legend.current || index < 0) return;
      legend.current.innerHTML =
        `<span><i style="display:inline-block;width:10px;height:2px;margin-right:4px;vertical-align:middle;background:${STRATEGY}"></i>Strategy <b class="text-foreground">${formatNumber(equity[index], 2)}</b></span>` +
        `<span><i style="display:inline-block;width:10px;height:2px;margin-right:4px;vertical-align:middle;background:${BENCH}"></i>Buy &amp; hold <b class="text-foreground">${formatNumber(benchmark[index], 2)}</b></span>` +
        `<span>Drawdown <b class="text-foreground">${formatPct(drawdown[index])}</b></span>`;
    };
    update(time.length - 1);
    chart.subscribeCrosshairMove((p) => {
      if (p.time == null) return update(time.length - 1);
      const t = p.time as number;
      let lo = 0;
      let hi = time.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (time[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      update(lo);
    });
    return () => chart.remove();
  }, [result]);

  return (
    <div className="relative h-full w-full" data-testid="equity-chart">
      <div ref={ref} className="absolute inset-0" />
      <div ref={legend} className="num pointer-events-none absolute left-2 top-1.5 z-10 flex gap-3 text-[11px] text-muted-foreground" />
    </div>
  );
}
