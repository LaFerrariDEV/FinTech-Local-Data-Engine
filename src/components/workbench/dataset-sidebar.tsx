"use client";

import { AlertTriangle, CandlestickChart, Database, Download, FlaskConical, MoreHorizontal, Sparkles, Table2, Trash2, Wand2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea, Spinner, Tip } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { downloadBytes, formatBytes, formatInt, formatInterval, formatMs, formatTime } from "@/lib/format";
import type { ColumnMapping, DatasetInfo, TsKind } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store/workbench";
import { DropZone } from "./drop-zone";
import { useEngine, useReadyClient } from "./engine-provider";

export function DatasetSidebar() {
  const datasets = useWorkbench((s) => s.datasets);
  const active = useWorkbench((s) => s.activeDataset);
  const setActive = useWorkbench((s) => s.setActive);
  const client = useReadyClient();
  const [sampleBusy, setSampleBusy] = React.useState<string | null>(null);
  const upsert = useWorkbench((s) => s.upsertDataset);

  const loadSample = async (kind: "daily" | "intraday") => {
    if (!client) return;
    setSampleBusy(kind);
    try {
      const ds = await client.call("sample", { kind, bars: kind === "daily" ? 2520 : 500_000 }, { timeoutMs: 120_000 });
      upsert(ds, true);
      toast.success(`Generated ${ds.name}`, { description: `${formatInt(ds.rows)} rows in ${formatMs(ds.ingestMs)}` });
    } catch (error) {
      toast.error("Sample generation failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSampleBusy(null);
    }
  };

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-panel" aria-label="Datasets">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="panel-title flex items-center gap-1.5">
          <Database className="size-3" /> Datasets
        </span>
        <span className="num text-[10.5px] text-muted-foreground">{datasets.length}</span>
      </div>
      <div className="px-3 pb-3">
        <DropZone />
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Tip content="3 symbols × 10 years of daily bars (geometric Brownian motion with regime volatility)">
            <Button size="sm" variant="secondary" disabled={!client || sampleBusy !== null} onClick={() => void loadSample("daily")} data-testid="sample-daily">
              {sampleBusy === "daily" ? <Spinner className="size-3" /> : <FlaskConical />} Daily sample
            </Button>
          </Tip>
          <Tip content="2 symbols × 500k one-minute bars (1M rows) with jumps — a stress test">
            <Button size="sm" variant="secondary" disabled={!client || sampleBusy !== null} onClick={() => void loadSample("intraday")} data-testid="sample-intraday">
              {sampleBusy === "intraday" ? <Spinner className="size-3" /> : <Sparkles />} 1M-row intraday
            </Button>
          </Tip>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 border-t border-border">
        <ul className="flex flex-col p-1.5" data-testid="dataset-list">
          {datasets.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted-foreground">No datasets yet.</li>}
          {datasets.map((d) => (
            <DatasetRow key={d.name} dataset={d} active={d.name === active} onSelect={() => setActive(d.name)} />
          ))}
        </ul>
      </ScrollArea>
      <MappingDialog />
    </aside>
  );
}

function DatasetRow({ dataset: d, active, onSelect }: { dataset: DatasetInfo; active: boolean; onSelect: () => void }) {
  const client = useReadyClient();
  const removeDataset = useWorkbench((s) => s.removeDataset);
  const openMapping = useWorkbench((s) => s.openMappingDialog);
  const setTab = useWorkbench((s) => s.setTab);
  const setSqlDraft = useWorkbench((s) => s.setSqlDraft);
  const [menu, setMenu] = React.useState(false);
  const intraday = (d.medianIntervalSec ?? 86_400) < 86_400;

  const exportAs = async (format: "csv" | "parquet") => {
    if (!client) return;
    try {
      const out = await client.call("export", { table: d.name, format }, { timeoutMs: 10 * 60_000 });
      downloadBytes(out.bytes, out.fileName, out.mime);
    } catch (error) {
      toast.error("Export failed", { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const drop = async () => {
    if (!client) return;
    try {
      await client.call("drop", { dataset: d.name });
      removeDataset(d.name);
    } catch (error) {
      toast.error("Could not remove dataset", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-testid={`dataset-${d.name}`}
        onClick={onSelect}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        className={cn(
          "group relative cursor-pointer rounded-md border border-transparent px-2 py-1.5 transition-colors hover:bg-accent",
          active && "border-border bg-accent",
        )}
      >
        {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
        <div className="flex items-center gap-1.5">
          {d.chartable ? <CandlestickChart className="size-3.5 shrink-0 text-primary" /> : <Table2 className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="num min-w-0 flex-1 truncate text-xs font-medium">{d.name}</span>
          {d.rejected.count > 0 && (
            <Tip content={`${formatInt(d.rejected.count)} malformed rows quarantined`}>
              <AlertTriangle className="size-3 text-warning" />
            </Tip>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Actions for ${d.name}`}
            className="opacity-0 group-hover:opacity-100 data-[open=true]:opacity-100"
            data-open={menu}
            onClick={(e) => {
              e.stopPropagation();
              setMenu((m) => !m);
            }}
          >
            <MoreHorizontal />
          </Button>
        </div>
        <div className="num mt-0.5 flex flex-wrap gap-x-2 pl-5 text-[10.5px] text-muted-foreground">
          <span>{formatInt(d.rows)} rows</span>
          {d.symbols.length > 1 && <span>{d.symbols.length} symbols</span>}
          {d.medianIntervalSec && <span>{formatInterval(d.medianIntervalSec)}</span>}
          {d.sizeBytes > 0 && <span>{formatBytes(d.sizeBytes)}</span>}
        </div>
        {d.start != null && (
          <div className="num pl-5 text-[10.5px] text-muted-foreground/80">
            {formatTime(d.start, intraday)} → {formatTime(d.end, intraday)}
          </div>
        )}
        {menu && (
          <div className="mt-1.5 flex flex-wrap gap-1 pl-5" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="outline" onClick={() => openMapping(d.name)}>
              <Wand2 /> Columns
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSqlDraft(`SELECT *\nFROM ${d.name}\nLIMIT 100;`);
                setTab("sql");
              }}
            >
              <Table2 /> Query
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportAs("csv")}>
              <Download /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportAs("parquet")}>
              <Download /> Parquet
            </Button>
            <Button size="sm" variant="ghost" className="text-[#f08a8a]" onClick={() => void drop()} aria-label={`Remove ${d.name}`}>
              <Trash2 /> Remove
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

const ROLES: { key: keyof Omit<ColumnMapping, "tsKind">; label: string; required?: boolean }[] = [
  { key: "ts", label: "Timestamp", required: true },
  { key: "close", label: "Close / price", required: true },
  { key: "open", label: "Open" },
  { key: "high", label: "High" },
  { key: "low", label: "Low" },
  { key: "volume", label: "Volume" },
  { key: "symbol", label: "Symbol" },
];

const TS_KINDS: { value: TsKind; label: string }[] = [
  { value: "native", label: "Date / timestamp" },
  { value: "string", label: "Text (auto-parse)" },
  { value: "epoch_s", label: "Unix seconds" },
  { value: "epoch_ms", label: "Unix milliseconds" },
  { value: "epoch_us", label: "Unix microseconds" },
  { value: "epoch_ns", label: "Unix nanoseconds" },
  { value: "yyyymmdd", label: "YYYYMMDD integer" },
];

const NONE = "__none__";

function MappingDialog() {
  const name = useWorkbench((s) => s.mappingDialogFor);
  const close = useWorkbench((s) => s.openMappingDialog);
  const dataset = useWorkbench((s) => s.datasets.find((d) => d.name === name) ?? null);
  const upsert = useWorkbench((s) => s.upsertDataset);
  const { client } = useEngine();
  const [mapping, setMapping] = React.useState<ColumnMapping | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setMapping(dataset ? { ...dataset.mapping } : null);
    setError(null);
  }, [dataset]);

  const apply = async () => {
    if (!client || !dataset || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      const ds = await client.call("remap", { dataset: dataset.name, mapping }, { timeoutMs: 10 * 60_000 });
      upsert(ds, true);
      toast.success(`Re-mapped ${ds.name}`, { description: `${formatInt(ds.rows)} OHLCV rows` });
      close(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(dataset)} onOpenChange={(open) => !open && close(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Column mapping · {dataset?.name}</DialogTitle>
          <DialogDescription>Map source columns onto the canonical OHLCV layout. The raw table is kept untouched.</DialogDescription>
        </DialogHeader>
        {dataset && mapping && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {ROLES.map((role) => (
              <div key={role.key} className="flex flex-col gap-1">
                <Label>
                  {role.label}
                  {role.required && <span className="text-critical"> *</span>}
                </Label>
                <Select value={mapping[role.key] ?? NONE} onValueChange={(v) => setMapping({ ...mapping, [role.key]: v === NONE ? null : v })}>
                  <SelectTrigger aria-label={role.label}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— none —</SelectItem>
                    {dataset.columns.map((c) => (
                      <SelectItem key={c.name} value={c.name}>
                        {c.name} <span className="text-muted-foreground">· {c.type}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <Label>Timestamp encoding</Label>
              <Select value={mapping.tsKind} onValueChange={(v) => setMapping({ ...mapping, tsKind: v as TsKind })}>
                <SelectTrigger aria-label="Timestamp encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TS_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {dataset && dataset.warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-border bg-panel p-2">
            {dataset.warnings.map((w) => (
              <li key={w} className="flex gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="warning">note</Badge> {w}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="whitespace-pre-wrap text-xs text-[#f08a8a]">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !mapping?.ts || !mapping?.close}>
            {busy && <Spinner className="size-3" />} Apply mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
