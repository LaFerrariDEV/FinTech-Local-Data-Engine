"use client";

import { FlaskConical, Play } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Spinner, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatInt, formatMs, formatNumber, formatPct, formatTime } from "@/lib/format";
import type { BacktestMetrics, BacktestResult, StrategySpec, Timeframe } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useActiveDataset, useWorkbench } from "@/store/workbench";
import { EquityChart } from "./equity-chart";
import { useReadyClient } from "./engine-provider";
import { PanelErrorBoundary } from "./error-boundary";

type StrategyType = StrategySpec["type"];

const STRATEGY_LABELS: Record<StrategyType, string> = {
  sma_cross: "SMA crossover",
  ema_cross: "EMA crossover",
  rsi_reversion: "RSI mean reversion",
  bbands_breakout: "Bollinger breakout",
  macd_trend: "MACD trend",
  buy_hold: "Buy & hold",
  custom_sql: "Custom SQL signal",
};

const DEFAULT_CUSTOM_SQL = `-- Return one row per bar: ts and position (-1 short … 0 flat … 1 long).
-- "bars" holds the selected symbol/timeframe: ts, open, high, low, close, volume.
SELECT ts,
  CASE WHEN close > avg(close) OVER (ORDER BY ts ROWS 49 PRECEDING)
        AND avg(close) OVER (ORDER BY ts ROWS 9 PRECEDING) > avg(close) OVER (ORDER BY ts ROWS 49 PRECEDING)
       THEN 1 ELSE 0 END AS position
FROM bars`;

interface Params {
  fast: number;
  slow: number;
  signal: number;
  period: number;
  lower: number;
  upper: number;
  mult: number;
  sql: string;
}

function buildStrategy(type: StrategyType, p: Params): StrategySpec {
  switch (type) {
    case "sma_cross":
    case "ema_cross":
      return { type, fast: p.fast, slow: p.slow };
    case "rsi_reversion":
      return { type, period: p.period, lower: p.lower, upper: p.upper };
    case "bbands_breakout":
      return { type, period: p.period, mult: p.mult };
    case "macd_trend":
      return { type, fast: p.fast, slow: p.slow, signal: p.signal };
    case "custom_sql":
      return { type, sql: p.sql };
    case "buy_hold":
      return { type };
  }
}

export function BacktestPanel() {
  const dataset = useActiveDataset();
  const symbol = useWorkbench((s) => s.activeSymbol);
  const result = useWorkbench((s) => s.backtest);
  const setResult = useWorkbench((s) => s.setBacktest);
  const client = useReadyClient();
  const [type, setType] = React.useState<StrategyType>("sma_cross");
  const [timeframe, setTimeframe] = React.useState<Timeframe>("auto");
  const [params, setParams] = React.useState<Params>({ fast: 20, slow: 50, signal: 9, period: 14, lower: 30, upper: 70, mult: 2, sql: DEFAULT_CUSTOM_SQL });
  const [feeBps, setFeeBps] = React.useState(1);
  const [slippageBps, setSlippageBps] = React.useState(1);
  const [allowShort, setAllowShort] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    if (!client || !dataset) return;
    setRunning(true);
    setError(null);
    try {
      const r = await client.call(
        "backtest",
        { dataset: dataset.name, symbol, timeframe, strategy: buildStrategy(type, params), feeBps, slippageBps, allowShort, initialCapital: 100_000 },
        { timeoutMs: 10 * 60_000 },
      );
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (!dataset?.chartable) {
    return (
      <EmptyState icon={<FlaskConical />} title="Load an OHLCV dataset to backtest">
        Strategies run as vectorized, look-ahead-free simulations inside the engine worker.
      </EmptyState>
    );
  }

  const num = (key: keyof Params, label: string, step = 1) => (
    <div className="flex w-16 flex-col gap-0.5">
      <Label htmlFor={`bt-${key}`}>{label}</Label>
      <Input
        id={`bt-${key}`}
        type="number"
        step={step}
        value={params[key] as number}
        onChange={(e) => setParams({ ...params, [key]: e.target.value === "" ? 0 : Number(e.target.value) })}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
        <div className="flex w-44 flex-col gap-0.5">
          <Label>Strategy</Label>
          <Select value={type} onValueChange={(v) => setType(v as StrategyType)}>
            <SelectTrigger aria-label="Strategy" data-testid="strategy-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STRATEGY_LABELS) as StrategyType[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {STRATEGY_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(type === "sma_cross" || type === "ema_cross" || type === "macd_trend") && (
          <>
            {num("fast", "Fast")}
            {num("slow", "Slow")}
            {type === "macd_trend" && num("signal", "Signal")}
          </>
        )}
        {type === "rsi_reversion" && (
          <>
            {num("period", "Period")}
            {num("lower", "Buy <")}
            {num("upper", "Exit >")}
          </>
        )}
        {type === "bbands_breakout" && (
          <>
            {num("period", "Period")}
            {num("mult", "σ mult", 0.1)}
          </>
        )}
        <div className="flex w-24 flex-col gap-0.5">
          <Label>Timeframe</Label>
          <Select value={timeframe} onValueChange={(v) => setTimeframe(v as Timeframe)}>
            <SelectTrigger aria-label="Backtest timeframe">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["auto", "raw", "1m", "5m", "15m", "1h", "4h", "1d", "1w"] as Timeframe[]).map((tf) => (
                <SelectItem key={tf} value={tf}>
                  {tf === "auto" ? "Native" : tf}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-16 flex-col gap-0.5">
          <Label htmlFor="bt-fee">Fee bps</Label>
          <Input id="bt-fee" type="number" min={0} step={0.5} value={feeBps} onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value)))} />
        </div>
        <div className="flex w-16 flex-col gap-0.5">
          <Label htmlFor="bt-slip">Slip bps</Label>
          <Input id="bt-slip" type="number" min={0} step={0.5} value={slippageBps} onChange={(e) => setSlippageBps(Math.max(0, Number(e.target.value)))} />
        </div>
        <label className="flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch checked={allowShort} onCheckedChange={setAllowShort} aria-label="Allow shorting" /> Short
        </label>
        <Button onClick={() => void run()} disabled={running || !client} data-testid="backtest-run">
          {running ? <Spinner className="size-3" /> : <Play />} Run backtest
        </Button>
        <span className="num pb-1 text-[10.5px] text-muted-foreground">
          {dataset.name}
          {symbol ? ` · ${symbol}` : ""}
        </span>
      </div>
      {type === "custom_sql" && (
        <div className="border-b border-border p-2">
          <Textarea
            aria-label="Custom signal SQL"
            rows={6}
            className="num text-[11.5px]"
            value={params.sql}
            onChange={(e) => setParams({ ...params, sql: e.target.value })}
            spellCheck={false}
          />
        </div>
      )}
      {error && (
        <div role="alert" className="m-3 whitespace-pre-wrap rounded-md border border-critical/40 bg-critical/10 p-2 text-xs text-[#f08a8a]">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {result ? (
          <PanelErrorBoundary label="Backtest results" resetKey={result}>
            <BacktestResults result={result} />
          </PanelErrorBoundary>
        ) : (
          !error && (
            <EmptyState icon={<FlaskConical />} title="Configure a strategy and run it">
              Positions decided at a bar&apos;s close are held over the next bar. Fees and slippage are charged on every change in position.
            </EmptyState>
          )
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2.5 py-2">
      <span className="panel-title truncate">{label}</span>
      <span className={cn("num truncate text-base font-semibold", tone === "good" && "text-[#6fd36f]", tone === "bad" && "text-[#f08a8a]")}>{value}</span>
      {sub && <span className="num truncate text-[10.5px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function BacktestResults({ result }: { result: BacktestResult }) {
  const m = result.metrics;
  const b = result.benchmark;
  const tone = (v: number) => (v > 0 ? "good" : v < 0 ? "bad" : undefined);
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="backtest-results">
      <div className="num text-[10.5px] text-muted-foreground">
        {result.dataset} · {result.symbol} · {result.timeframe} · {formatInt(m.bars)} bars · {STRATEGY_LABELS[result.strategy.type]} · {formatMs(result.elapsedMs)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Total return" value={formatPct(m.totalReturn, 2, true)} sub={`B&H ${formatPct(b.totalReturn, 2, true)}`} tone={tone(m.totalReturn)} />
        <Kpi label="CAGR" value={formatPct(m.cagr, 2, true)} sub={`B&H ${formatPct(b.cagr, 2, true)}`} tone={tone(m.cagr)} />
        <Kpi label="Sharpe" value={formatNumber(m.sharpe, 2)} sub={`B&H ${formatNumber(b.sharpe, 2)}`} />
        <Kpi label="Sortino" value={formatNumber(m.sortino, 2)} sub={`Calmar ${formatNumber(m.calmar, 2)}`} />
        <Kpi label="Max drawdown" value={formatPct(m.maxDrawdown)} sub={`B&H ${formatPct(b.maxDrawdown)}`} tone={m.maxDrawdown < 0 ? "bad" : undefined} />
        <Kpi label="Volatility" value={formatPct(m.volatility)} sub="annualized" />
        <Kpi label="Trades" value={formatInt(m.trades)} sub={`win ${formatPct(m.winRate, 1)}`} />
        <Kpi label="Profit factor" value={formatNumber(m.profitFactor, 2)} sub={`exposure ${formatPct(m.exposure, 0)}`} />
      </div>
      <div className="h-80 overflow-hidden rounded-md border border-border">
        <EquityChart result={result} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-panel p-2">
          <h3 className="panel-title mb-1">Bar return distribution</h3>
          <ReturnHistogram data={result.returnHistogram} />
        </section>
        <section className="rounded-md border border-border bg-panel p-2">
          <h3 className="panel-title mb-1">Monthly returns</h3>
          <MonthlyHeatmap result={result} />
        </section>
      </div>
      <MetricsTable strategy={m} benchmark={b} />
      <TradesTable result={result} />
    </div>
  );
}

function ReturnHistogram({ data }: { data: BacktestResult["returnHistogram"] }) {
  if (data.length === 0) return <div className="p-4 text-xs text-muted-foreground">No non-zero returns (strategy never in the market).</div>;
  const rows = data.map((d) => ({ mid: (d.binStart + d.binEnd) / 2, label: `${formatPct(d.binStart)} … ${formatPct(d.binEnd)}`, count: d.count }));
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap={2}>
          <CartesianGrid stroke="#1a1d22" vertical={false} />
          <XAxis dataKey="mid" tickFormatter={(v: number) => formatPct(v, 1)} tick={{ fill: "#6b7079", fontSize: 10 }} stroke="#23262c" interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={{ fill: "#6b7079", fontSize: 10 }} stroke="#23262c" allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={{ background: "#121418", border: "1px solid #23262c", borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: "#e6e7ea" }}
            itemStyle={{ color: "#c3c2b7" }}
            labelFormatter={(_, payload) => (payload?.[0]?.payload as { label?: string } | undefined)?.label ?? ""}
            formatter={(v) => [formatInt(Number(v)), "bars"]}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.mid} fill={r.mid >= 0 ? "#0ca30c" : "#d03b3b"} fillOpacity={0.75} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function heatColor(ret: number, scale: number): string {
  const t = Math.min(1, Math.abs(ret) / scale);
  const alpha = 0.12 + 0.68 * t;
  return ret >= 0 ? `rgba(12,163,12,${alpha})` : `rgba(208,59,59,${alpha})`;
}

function MonthlyHeatmap({ result }: { result: BacktestResult }) {
  const byYear = new Map<number, Map<number, number>>();
  for (const m of result.monthly) {
    if (!byYear.has(m.year)) byYear.set(m.year, new Map());
    byYear.get(m.year)!.set(m.month, m.ret);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => b - a).slice(0, 30);
  const sorted = result.monthly.map((m) => Math.abs(m.ret)).sort((a, b) => a - b);
  const scale = sorted[Math.floor(sorted.length * 0.9)] || 0.05;
  return (
    <div className="num overflow-auto text-[10px]">
      <table className="w-full border-separate border-spacing-[2px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-10 text-left font-normal" />
            {MONTHS.map((m, i) => (
              <th key={i} className="font-normal">
                {m}
              </th>
            ))}
            <th className="font-normal">Year</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const months = byYear.get(y)!;
            const yearRet = Array.from(months.values()).reduce((acc, r) => acc * (1 + r), 1) - 1;
            return (
              <tr key={y}>
                <td className="text-muted-foreground">{y}</td>
                {MONTHS.map((_, i) => {
                  const r = months.get(i + 1);
                  return (
                    <td
                      key={i}
                      title={r == null ? undefined : `${y}-${String(i + 1).padStart(2, "0")}: ${formatPct(r)}`}
                      className="h-5 rounded-[3px] text-center text-foreground/90"
                      style={{ background: r == null ? "transparent" : heatColor(r, scale) }}
                    >
                      {r == null ? "" : (r * 100).toFixed(1)}
                    </td>
                  );
                })}
                <td className={cn("text-right font-semibold", yearRet >= 0 ? "text-[#6fd36f]" : "text-[#f08a8a]")}>{formatPct(yearRet, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricsTable({ strategy, benchmark }: { strategy: BacktestMetrics; benchmark: BacktestMetrics }) {
  const rows: [string, (m: BacktestMetrics) => string][] = [
    ["Total return", (m) => formatPct(m.totalReturn)],
    ["CAGR", (m) => formatPct(m.cagr)],
    ["Annualized volatility", (m) => formatPct(m.volatility)],
    ["Sharpe (rf = 0)", (m) => formatNumber(m.sharpe, 3)],
    ["Sortino", (m) => formatNumber(m.sortino, 3)],
    ["Max drawdown", (m) => formatPct(m.maxDrawdown)],
    ["Longest drawdown (bars)", (m) => formatInt(m.maxDrawdownDurationBars)],
    ["Calmar", (m) => formatNumber(m.calmar, 3)],
    ["Trades", (m) => formatInt(m.trades)],
    ["Win rate", (m) => formatPct(m.winRate, 1)],
    ["Avg win / loss", (m) => `${formatPct(m.avgWin)} / ${formatPct(m.avgLoss)}`],
    ["Exposure", (m) => formatPct(m.exposure, 1)],
    ["Turnover (×)", (m) => formatNumber(m.turnover, 1)],
    ["Final equity", (m) => formatNumber(m.finalEquity, 2)],
    ["Bars per year", (m) => formatNumber(m.periodsPerYear, 1)],
  ];
  return (
    <section className="rounded-md border border-border bg-panel">
      <h3 className="panel-title border-b border-border px-2 py-1.5">Statistics</h3>
      <table className="num w-full text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-2 py-1 text-left font-normal">Metric</th>
            <th className="px-2 py-1 text-right font-normal">Strategy</th>
            <th className="px-2 py-1 text-right font-normal">Buy &amp; hold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label} className="border-t border-border/50">
              <td className="px-2 py-0.5 text-muted-foreground">{label}</td>
              <td className="px-2 py-0.5 text-right">{f(strategy)}</td>
              <td className="px-2 py-0.5 text-right text-muted-foreground">{f(benchmark)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TradesTable({ result }: { result: BacktestResult }) {
  const intraday = !["1d", "1w", "1M"].includes(result.timeframe) && (result.curve.time.length < 2 || result.curve.time[1] - result.curve.time[0] < 86_400);
  const trades = result.trades.slice().reverse().slice(0, 300);
  return (
    <section className="rounded-md border border-border bg-panel">
      <h3 className="panel-title border-b border-border px-2 py-1.5">
        Trades {result.tradesTruncated && <span className="normal-case tracking-normal">(most recent {formatInt(result.trades.length)})</span>}
      </h3>
      <div className="max-h-72 overflow-auto">
        <table className="num w-full text-[11px]">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-muted-foreground">
              <th className="px-2 py-1 text-left font-normal">Side</th>
              <th className="px-2 py-1 text-left font-normal">Entry</th>
              <th className="px-2 py-1 text-right font-normal">Price</th>
              <th className="px-2 py-1 text-left font-normal">Exit</th>
              <th className="px-2 py-1 text-right font-normal">Price</th>
              <th className="px-2 py-1 text-right font-normal">Bars</th>
              <th className="px-2 py-1 text-right font-normal">Return</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className="border-t border-border/50">
                <td className={cn("px-2 py-0.5", t.side === 1 ? "text-[#8fbaf0]" : "text-[#e8a07f]")}>
                  {t.side === 1 ? "LONG" : "SHORT"}
                  {t.open ? " · open" : ""}
                </td>
                <td className="px-2 py-0.5">{formatTime(t.entryTime, intraday)}</td>
                <td className="px-2 py-0.5 text-right">{formatNumber(t.entryPrice)}</td>
                <td className="px-2 py-0.5">{formatTime(t.exitTime, intraday)}</td>
                <td className="px-2 py-0.5 text-right">{formatNumber(t.exitPrice)}</td>
                <td className="px-2 py-0.5 text-right">{formatInt(t.bars)}</td>
                <td className={cn("px-2 py-0.5 text-right", t.returnPct >= 0 ? "text-[#6fd36f]" : "text-[#f08a8a]")}>{formatPct(t.returnPct, 2, true)}</td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                  No trades.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
