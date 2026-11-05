"use client";

import { Activity, Bot, CandlestickChart, Cpu, Database, FlaskConical, HardDrive, PanelRightClose, PanelRightOpen, RotateCcw, ShieldCheck, Terminal } from "lucide-react";
import * as React from "react";
import { Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner, Switch, Tip, TooltipProvider } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatInt, formatMs } from "@/lib/format";
import type { EngineStats } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useWorkbench, type WorkbenchTab } from "@/store/workbench";
import { AgentPanel } from "./agent-panel";
import { BacktestPanel } from "./backtest-panel";
import { ChartPanel } from "./chart-panel";
import { DatasetSidebar } from "./dataset-sidebar";
import { GlobalDropOverlay } from "./drop-zone";
import { EngineProvider, useEngine } from "./engine-provider";
import { PanelErrorBoundary } from "./error-boundary";
import { QualityPanel } from "./quality-panel";
import { SqlConsole } from "./sql-console";

export function Workbench() {
  return (
    <TooltipProvider>
      <EngineProvider>
        <Shell />
        <GlobalDropOverlay />
        <Toaster theme="dark" position="bottom-right" toastOptions={{ style: { background: "#121418", border: "1px solid #23262c", fontSize: 12 } }} />
      </EngineProvider>
    </TooltipProvider>
  );
}

function Shell() {
  const tab = useWorkbench((s) => s.tab);
  const setTab = useWorkbench((s) => s.setTab);
  const agentOpen = useWorkbench((s) => s.agentOpen);
  const setAgentOpen = useWorkbench((s) => s.setAgentOpen);
  const active = useWorkbench((s) => s.activeDataset);

  return (
    <div className="grid h-dvh grid-rows-[40px_1fr_24px] overflow-hidden">
      <TopBar />
      <div className={cn("grid min-h-0", agentOpen ? "grid-cols-[256px_1fr_360px]" : "grid-cols-[256px_1fr]")}>
        <PanelErrorBoundary label="Dataset sidebar">
          <DatasetSidebar />
        </PanelErrorBoundary>
        <main className="flex min-h-0 min-w-0 flex-col">
          <Tabs value={tab} onValueChange={(v) => setTab(v as WorkbenchTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center border-b border-border bg-panel pr-2">
              <TabsList className="px-1">
                <TabsTrigger value="chart" data-testid="tab-chart">
                  <CandlestickChart /> Chart
                </TabsTrigger>
                <TabsTrigger value="sql" data-testid="tab-sql">
                  <Terminal /> SQL
                </TabsTrigger>
                <TabsTrigger value="backtest" data-testid="tab-backtest">
                  <FlaskConical /> Backtest
                </TabsTrigger>
                <TabsTrigger value="quality" data-testid="tab-quality">
                  <ShieldCheck /> Quality
                </TabsTrigger>
              </TabsList>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAgentOpen(!agentOpen)} aria-label={agentOpen ? "Hide agent" : "Show agent"}>
                {agentOpen ? <PanelRightClose /> : <PanelRightOpen />}
                <Bot /> Agent
              </Button>
            </div>
            <TabsContent value="chart" className="min-h-0 flex-1">
              <PanelErrorBoundary label="Chart panel" resetKey={active}>
                <ChartPanel />
              </PanelErrorBoundary>
            </TabsContent>
            <TabsContent value="sql" className="min-h-0 flex-1">
              <PanelErrorBoundary label="SQL console">
                <SqlConsole />
              </PanelErrorBoundary>
            </TabsContent>
            <TabsContent value="backtest" className="min-h-0 flex-1">
              <PanelErrorBoundary label="Backtest" resetKey={active}>
                <BacktestPanel />
              </PanelErrorBoundary>
            </TabsContent>
            <TabsContent value="quality" className="min-h-0 flex-1">
              <PanelErrorBoundary label="Quality report" resetKey={active}>
                <QualityPanel />
              </PanelErrorBoundary>
            </TabsContent>
          </Tabs>
        </main>
        {agentOpen && (
          <PanelErrorBoundary label="Agent">
            <AgentPanel />
          </PanelErrorBoundary>
        )}
      </div>
      <StatusBar />
    </div>
  );
}

function TopBar() {
  const { status, restart, persist, setPersist } = useEngine();
  const s = status.status;
  const tone = s === "ready" ? "good" : s === "booting" || s === "idle" ? "default" : s === "unresponsive" ? "warning" : "critical";
  return (
    <header className="flex items-center gap-3 border-b border-border bg-panel px-3">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded bg-primary/15">
          <Activity className="size-3.5 text-primary" />
        </div>
        <span className="text-sm font-semibold tracking-tight">QuantAgent</span>
        <span className="hidden text-[11px] text-muted-foreground md:inline">local-first quant workbench</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <Tip content="Persist datasets in the browser's Origin Private File System (survives reloads). Switching restarts the engine.">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <HardDrive className="size-3.5" />
            Persist
            <Switch checked={persist} onCheckedChange={setPersist} aria-label="Persist data across reloads" />
          </label>
        </Tip>
        <Badge variant={tone} data-testid="engine-status" data-status={s} className="num">
          {s === "booting" || s === "idle" ? <Spinner className="size-2.5" /> : <Cpu />}
          {s === "ready" ? `DuckDB ${status.info?.duckdbVersion ?? ""} · ${status.info?.bundle ?? ""}` : s === "booting" || s === "idle" ? "Booting engine…" : s}
        </Badge>
        {(s === "crashed" || s === "failed" || s === "unresponsive") && (
          <Button size="sm" variant="outline" onClick={restart} data-testid="engine-restart">
            <RotateCcw /> Restart engine
          </Button>
        )}
      </div>
      {(s === "crashed" || s === "failed") && status.error && (
        <div role="alert" className="fixed left-1/2 top-12 z-40 max-w-xl -translate-x-1/2 rounded-md border border-critical/50 bg-[#1f1214] px-3 py-2 text-xs text-[#f08a8a] shadow-xl" data-testid="engine-error">
          {status.error}. {s === "crashed" ? "In-memory data was lost; persisted data reloads after restart." : ""}
        </div>
      )}
    </header>
  );
}

function StatusBar() {
  const { client, status } = useEngine();
  const datasets = useWorkbench((s) => s.datasets);
  const [stats, setStats] = React.useState<EngineStats | null>(null);
  const ready = status.status === "ready";

  React.useEffect(() => {
    if (!client || !ready) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const tick = () =>
      client
        .call("stats", {} as never, { timeoutMs: 10_000 })
        .then((s) => !cancelled && setStats(s))
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, ready, datasets]);

  const rows = datasets.reduce((a, d) => a + d.rows, 0);
  return (
    <footer className="num flex items-center gap-4 border-t border-border bg-panel px-3 text-[10.5px] text-muted-foreground" data-testid="status-bar">
      <span className="flex items-center gap-1">
        <span className={cn("size-1.5 rounded-full", ready ? "bg-good" : status.status === "booting" ? "bg-warning" : "bg-critical")} />
        engine {status.status}
      </span>
      {status.info && <span>boot {formatMs(status.info.bootMs)}</span>}
      {status.info && (
        <span className="flex items-center gap-1">
          <Database className="size-3" />
          {status.info.persistence === "opfs" ? "OPFS persistent" : "in-memory"}
          {status.info.persistenceError ? " (persistence unavailable)" : ""}
        </span>
      )}
      <span>
        {datasets.length} dataset(s) · {formatInt(rows)} rows
      </span>
      {stats && <span>DuckDB memory {formatBytes(stats.memoryBytes)}</span>}
      {status.pending > 0 && <span>{status.pending} pending</span>}
      <span className="ml-auto">all computation runs locally · no data leaves this browser</span>
    </footer>
  );
}
