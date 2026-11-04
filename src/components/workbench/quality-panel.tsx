"use client";

import { AlertOctagon, AlertTriangle, Info, RefreshCw, ShieldCheck } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { formatInt, formatMs, formatNumber, formatTime } from "@/lib/format";
import type { QualityReport, QualitySeverity } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useActiveDataset } from "@/store/workbench";
import { useReadyClient } from "./engine-provider";

const SEVERITY: Record<QualitySeverity, { icon: React.ReactNode; label: string; className: string }> = {
  error: { icon: <AlertOctagon className="size-3.5" />, label: "Error", className: "text-critical" },
  warning: { icon: <AlertTriangle className="size-3.5" />, label: "Warning", className: "text-warning" },
  info: { icon: <Info className="size-3.5" />, label: "Info", className: "text-[#8fbaf0]" },
};

export function QualityPanel() {
  const dataset = useActiveDataset();
  const client = useReadyClient();
  const [report, setReport] = React.useState<QualityReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!client || !dataset) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await client.call("quality", { dataset: dataset.name }, { timeoutMs: 5 * 60_000 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, dataset]);

  React.useEffect(() => {
    setReport(null);
    void load();
  }, [load]);

  if (!dataset) return <EmptyState icon={<ShieldCheck />} title="No dataset selected" />;

  const scoreTone = !report ? "" : report.score >= 90 ? "text-[#6fd36f]" : report.score >= 70 ? "text-warning" : "text-[#f08a8a]";
  const intraday = (dataset.medianIntervalSec ?? 86_400) < 86_400;

  return (
    <div className="h-full overflow-auto p-3" data-testid="quality-panel">
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <div className="flex items-baseline gap-2">
          <span className={cn("num text-3xl font-semibold", scoreTone)} data-testid="quality-score">
            {report ? report.score : "—"}
          </span>
          <span className="text-xs text-muted-foreground">/ 100 data quality</span>
        </div>
        {report && (
          <div className="num flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
            <span>{formatInt(report.rows)} rows</span>
            <span>{report.symbols} symbol(s)</span>
            <span>
              {formatTime(report.start, intraday)} → {formatTime(report.end, intraday)}
            </span>
            <span>audit {formatMs(report.elapsedMs)}</span>
          </div>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner className="size-3" /> : <RefreshCw />} Re-run audit
        </Button>
      </div>
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-critical/40 bg-critical/10 p-2 text-xs text-[#f08a8a]">
          {error}
        </div>
      )}
      {report && report.issues.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-good/40 bg-good/10 p-3 text-xs">
          <ShieldCheck className="size-4 text-good" /> No issues found. OHLC consistency, prices, volume, duplicates, gaps, outliers and stale runs all check out.
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {report?.issues.map((issue) => {
          const sev = SEVERITY[issue.severity];
          const keys = issue.examples.length ? Object.keys(issue.examples[0]).filter((k) => issue.examples.some((e) => e[k] != null)) : [];
          return (
            <li key={issue.id} className="rounded-md border border-border bg-panel" data-testid={`issue-${issue.id}`}>
              <div className="flex items-start gap-2 p-2">
                <span className={cn("mt-0.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase", sev.className)}>
                  {sev.icon}
                  {sev.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">
                    {issue.title} <span className="num text-muted-foreground">· {formatInt(issue.count)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{issue.detail}</div>
                </div>
              </div>
              {keys.length > 0 && (
                <div className="overflow-auto border-t border-border">
                  <table className="num w-full text-[10.5px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        {keys.map((k) => (
                          <th key={k} className="px-2 py-1 text-left font-normal">
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {issue.examples.map((ex, i) => (
                        <tr key={i} className="border-t border-border/50">
                          {keys.map((k) => (
                            <td key={k} className="max-w-xs truncate px-2 py-0.5">
                              {ex[k] == null ? "" : typeof ex[k] === "number" ? formatNumber(ex[k] as number) : String(ex[k])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
