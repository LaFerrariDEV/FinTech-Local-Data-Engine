"use client";

import { AlertTriangle, CandlestickChart, Code2, Plus, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner, Tip } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatInt, formatInterval, formatMs } from "@/lib/format";
import { indicatorLabel, INDICATOR_PRESETS } from "@/lib/quant/indicators";
import { indicatorKey } from "@/lib/quant/ohlcv-sql";
import { TIMEFRAME_SECONDS, type BarsResult, type IndicatorSpec, type Timeframe } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useActiveDataset, useWorkbench } from "@/store/workbench";
import { useReadyClient } from "./engine-provider";
import { PanelErrorBoundary } from "./error-boundary";
import { PriceChart } from "./price-chart";

const TIMEFRAMES: Timeframe[] = ["auto", "raw", "1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"];

export function ChartPanel() {
  const dataset = useActiveDataset();
  const symbol = useWorkbench((s) => s.activeSymbol);
  const setSymbol = useWorkbench((s) => s.setSymbol);
  const timeframe = useWorkbench((s) => s.timeframe);
  const setTimeframe = useWorkbench((s) => s.setTimeframe);
  const indicators = useWorkbench((s) => s.indicators);
  const setIndicators = useWorkbench((s) => s.setIndicators);
  const setTab = useWorkbench((s) => s.setTab);
  const setSqlDraft = useWorkbench((s) => s.setSqlDraft);
  const client = useReadyClient();
  const [bars, setBars] = React.useState<BarsResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const requestSeq = React.useRef(0);
  const pickerRef = React.useRef<HTMLDivElement>(null);

  // Close the indicator picker on outside click or Escape.
  React.useEffect(() => {
    if (!pickerOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  React.useEffect(() => {
    if (!client || !dataset?.chartable) {
      setBars(null);
      return;
    }
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client
      .call("bars", { dataset: dataset.name, symbol, timeframe, indicators, maxBars: 20_000 }, { signal: controller.signal, timeoutMs: 120_000 })
      .then((result) => {
        // Drop stale responses so rapid toggling never renders out-of-order data.
        if (seq === requestSeq.current) setBars(result);
      })
      .catch((e: Error) => {
        if (seq === requestSeq.current && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    return () => controller.abort();
  }, [client, dataset?.name, dataset?.chartable, dataset?.createdAt, symbol, timeframe, indicators]);

  if (!dataset) {
    return (
      <EmptyState icon={<CandlestickChart />} title="No dataset loaded">
        Drop a CSV or Parquet file with OHLCV data anywhere on the window, or generate a sample dataset from the sidebar.
      </EmptyState>
    );
  }
  if (!dataset.chartable) {
    return (
      <EmptyState icon={<AlertTriangle />} title={`${dataset.name} has no timestamp/price mapping`}>
        <p>It is still fully queryable from the SQL tab.</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => useWorkbench.getState().openMappingDialog(dataset.name)}>
          Map columns
        </Button>
      </EmptyState>
    );
  }

  const native = dataset.medianIntervalSec ?? 0;
  const availableTf = TIMEFRAMES.filter((tf) => tf === "auto" || tf === "raw" || TIMEFRAME_SECONDS[tf] >= native * 0.999);
  const activeKeys = new Set(indicators.map(indicatorKey));
  const toggle = (spec: IndicatorSpec) => {
    const key = indicatorKey(spec);
    setIndicators(activeKeys.has(key) ? indicators.filter((i) => indicatorKey(i) !== key) : [...indicators, spec]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        {dataset.symbols.length > 1 && (
          <Select value={symbol ?? dataset.symbols[0]} onValueChange={(v) => setSymbol(v)}>
            <SelectTrigger className="h-6 w-32" aria-label="Symbol" data-testid="symbol-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dataset.symbols.slice(0, 500).map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center rounded-md border border-border bg-panel p-0.5" role="radiogroup" aria-label="Timeframe">
          {availableTf.map((tf) => (
            <button
              key={tf}
              role="radio"
              aria-checked={timeframe === tf}
              data-testid={`tf-${tf}`}
              onClick={() => setTimeframe(tf)}
              className={cn(
                "num h-5 rounded px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground",
                timeframe === tf && "bg-accent text-foreground",
              )}
            >
              {tf === "auto" ? "Auto" : tf === "raw" ? "Raw" : tf}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {indicators.map((spec) => (
            <span key={indicatorKey(spec)} className="num inline-flex h-5 items-center gap-1 rounded border border-border bg-panel-2 pl-1.5 pr-0.5 text-[10.5px]">
              {indicatorLabel(spec)}
              <button aria-label={`Remove ${indicatorLabel(spec)}`} onClick={() => toggle(spec)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <div className="relative" ref={pickerRef}>
            <Button size="sm" variant="ghost" onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen} data-testid="indicator-picker">
              <Plus /> Indicator
            </Button>
            {pickerOpen && (
              <div
                role="menu"
                className="absolute left-0 top-7 z-30 grid w-56 grid-cols-2 gap-1 rounded-md border border-border bg-popover p-1.5 shadow-xl shadow-black/50"
              >
                {INDICATOR_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    role="menuitemcheckbox"
                    aria-checked={activeKeys.has(indicatorKey(p.spec))}
                    data-testid={`indicator-${indicatorKey(p.spec)}`}
                    onClick={() => toggle(p.spec)}
                    className={cn(
                      "rounded px-2 py-1 text-left text-[11px] hover:bg-accent",
                      activeKeys.has(indicatorKey(p.spec)) && "bg-primary/15 text-[#8fbaf0]",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="num ml-auto flex items-center gap-3 text-[10.5px] text-muted-foreground">
          {loading && <Spinner className="size-3" />}
          {bars && (
            <>
              <span data-testid="chart-stats">
                {formatInt(bars.time.length)} bars · {bars.timeframe === "raw" ? `raw ${formatInterval(dataset.medianIntervalSec)}` : bars.timeframe}
              </span>
              <span>{formatInt(bars.sourceRows)} rows scanned</span>
              <span>{formatMs(bars.queryMs)}</span>
              <Tip content="Open the SQL that produced this chart">
                <button
                  className="hover:text-foreground"
                  aria-label="Show SQL"
                  onClick={() => {
                    setSqlDraft(`-- Generated by the chart (${bars.symbol}, ${bars.timeframe})\n${bars.sql}`);
                    setTab("sql");
                  }}
                >
                  <Code2 className="size-3.5" />
                </button>
              </Tip>
            </>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {error && (
          <div role="alert" className="absolute inset-x-3 top-3 z-20 rounded-md border border-critical/40 bg-critical/10 p-2 text-xs text-[#f08a8a]">
            {error}
          </div>
        )}
        <PanelErrorBoundary label="Chart" resetKey={bars}>
          {bars ? (
            <PriceChart bars={bars} intraday={(dataset.medianIntervalSec ?? 86_400) < 86_400} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}
