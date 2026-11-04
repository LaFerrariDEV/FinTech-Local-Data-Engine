"use client";

import type { SQLNamespace } from "@codemirror/lang-sql";
import { Download, History, Play, Square, TableProperties } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd, ScrollArea, Spinner } from "@/components/ui/misc";
import { downloadBytes, formatInt, formatMs } from "@/lib/format";
import type { CatalogTable, QueryResult } from "@/lib/quant/types";
import { cn } from "@/lib/utils";
import { useActiveDataset, useWorkbench } from "@/store/workbench";
import { useReadyClient } from "./engine-provider";
import { PanelErrorBoundary } from "./error-boundary";
import { ResultsGrid } from "./results-grid";
import { SqlEditor } from "./sql-editor";

function snippets(table: string) {
  return [
    {
      label: "50/200-day moving averages",
      sql: `SELECT symbol, ts, close,
  avg(close) OVER w50  AS sma_50,
  avg(close) OVER w200 AS sma_200
FROM ${table}
WINDOW
  w50  AS (PARTITION BY symbol ORDER BY ts ROWS BETWEEN 49 PRECEDING AND CURRENT ROW),
  w200 AS (PARTITION BY symbol ORDER BY ts ROWS BETWEEN 199 PRECEDING AND CURRENT ROW)
ORDER BY symbol, ts DESC
LIMIT 500;`,
    },
    {
      label: "Monthly closing trend",
      sql: `SELECT symbol,
  date_trunc('month', ts) AS month,
  arg_max(close, ts)      AS month_close,
  arg_max(close, ts) / lag(arg_max(close, ts)) OVER (PARTITION BY symbol ORDER BY date_trunc('month', ts)) - 1 AS mom_return
FROM ${table}
GROUP BY ALL
ORDER BY symbol, month;`,
    },
    {
      label: "Annualized volatility & Sharpe",
      sql: `WITH r AS (
  SELECT symbol, ln(close / lag(close) OVER (PARTITION BY symbol ORDER BY ts)) AS lr
  FROM ${table}
)
SELECT symbol,
  count(lr)                                   AS bars,
  avg(lr) * 252                               AS ann_return,
  stddev_samp(lr) * sqrt(252)                 AS ann_vol,
  avg(lr) / nullif(stddev_samp(lr), 0) * sqrt(252) AS sharpe
FROM r GROUP BY symbol ORDER BY sharpe DESC;`,
    },
    {
      label: "Max drawdown per symbol",
      sql: `SELECT symbol, min(close / peak - 1) AS max_drawdown
FROM (
  SELECT symbol, close, max(close) OVER (PARTITION BY symbol ORDER BY ts ROWS UNBOUNDED PRECEDING) AS peak
  FROM ${table}
)
GROUP BY symbol ORDER BY max_drawdown;`,
    },
    {
      label: "Weekly OHLC resample",
      sql: `SELECT symbol,
  time_bucket(INTERVAL '1 week', ts) AS week,
  arg_min(open, ts) AS open, max(high) AS high, min(low) AS low, arg_max(close, ts) AS close, sum(volume) AS volume
FROM ${table}
GROUP BY ALL ORDER BY symbol, week;`,
    },
    { label: "Profile columns (SUMMARIZE)", sql: `SUMMARIZE ${table};` },
  ];
}

export function SqlConsole() {
  const client = useReadyClient();
  const draft = useWorkbench((s) => s.sqlDraft);
  const setDraft = useWorkbench((s) => s.setSqlDraft);
  const history = useWorkbench((s) => s.sqlHistory);
  const pushHistory = useWorkbench((s) => s.pushHistory);
  const setDatasets = useWorkbench((s) => s.setDatasets);
  const dataset = useActiveDataset();
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [catalog, setCatalog] = React.useState<CatalogTable[]>([]);
  const [side, setSide] = React.useState<"schema" | "history">("schema");
  const lastSql = React.useRef("");
  const controller = React.useRef<AbortController | null>(null);
  const datasets = useWorkbench((s) => s.datasets);

  const refreshCatalog = React.useCallback(async () => {
    if (!client) return;
    try {
      setCatalog(await client.call("catalog", {} as never));
    } catch {
      // Catalog refresh is best-effort.
    }
  }, [client]);

  React.useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog, datasets]);

  React.useEffect(() => {
    if (!draft && dataset) setDraft(`SELECT *\nFROM ${dataset.name}\n${dataset.chartable ? "ORDER BY ts DESC\n" : ""}LIMIT 1000;`);
  }, [draft, dataset, setDraft]);

  const schema = React.useMemo<SQLNamespace>(() => {
    const ns: Record<string, string[]> = {};
    for (const t of catalog) if (!t.internal) ns[t.name] = t.columns.map((c) => c.name);
    return ns;
  }, [catalog]);

  const run = React.useCallback(
    async (text?: string) => {
      const sql = (text ?? draft).trim();
      if (!client || !sql || running) return;
      controller.current = new AbortController();
      setRunning(true);
      setError(null);
      lastSql.current = sql;
      try {
        const r = await client.call("query", { sql, maxRows: 100_000 }, { signal: controller.current.signal, timeoutMs: 30 * 60_000 });
        setResult(r);
        pushHistory(sql);
        if (r.mutatedCatalog) {
          await refreshCatalog();
          setDatasets(await client.call("datasets", {} as never));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
        controller.current = null;
      }
    },
    [client, draft, running, pushHistory, refreshCatalog, setDatasets],
  );

  const exportResult = async (format: "csv" | "parquet") => {
    if (!client || !lastSql.current) return;
    try {
      const out = await client.call("export", { sql: lastSql.current, format }, { timeoutMs: 10 * 60_000 });
      downloadBytes(out.bytes, out.fileName, out.mime);
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_220px] grid-rows-[minmax(140px,38%)_1fr]">
      <div className="flex min-h-0 flex-col border-b border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          {running ? (
            <Button size="sm" variant="destructive" onClick={() => controller.current?.abort()} data-testid="sql-cancel">
              <Square /> Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={() => void run()} disabled={!client} data-testid="sql-run">
              <Play /> Run
            </Button>
          )}
          <span className="text-[10.5px] text-muted-foreground">
            <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd> runs selection or script
          </span>
          {dataset && (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {snippets(dataset.name)
                .filter((s) => dataset.chartable || s.label.startsWith("Profile"))
                .map((s) => (
                  <Button key={s.label} size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setDraft(s.sql)}>
                    {s.label}
                  </Button>
                ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <PanelErrorBoundary label="SQL editor">
            <SqlEditor value={draft} onChange={setDraft} onRun={(t) => void run(t)} schema={schema} />
          </PanelErrorBoundary>
        </div>
      </div>
      <aside className="row-span-2 flex min-h-0 flex-col border-l border-border bg-panel">
        <div className="flex border-b border-border">
          {(["schema", "history"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSide(k)}
              className={cn("flex flex-1 items-center justify-center gap-1 py-1.5 text-[11px] text-muted-foreground", side === k && "bg-accent text-foreground")}
            >
              {k === "schema" ? <TableProperties className="size-3" /> : <History className="size-3" />} {k === "schema" ? "Schema" : "History"}
            </button>
          ))}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {side === "schema" ? (
            <ul className="p-1.5 text-[11px]">
              {catalog
                .filter((t) => !t.internal)
                .map((t) => (
                  <li key={t.name} className="mb-1.5">
                    <button className="num w-full truncate rounded px-1 text-left font-medium hover:bg-accent" onClick={() => setDraft(`SELECT * FROM ${t.name} LIMIT 100;`)}>
                      {t.name}
                      <span className="ml-1 text-[10px] text-muted-foreground">{t.kind === "view" ? "view" : t.rows != null ? formatInt(t.rows) : ""}</span>
                    </button>
                    <ul className="pl-3">
                      {t.columns.slice(0, 40).map((c) => (
                        <li key={c.name} className="num flex justify-between gap-2 truncate text-[10.5px] text-muted-foreground">
                          <span className="truncate">{c.name}</span>
                          <span className="shrink-0 opacity-70">{c.type.toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ul>
          ) : (
            <ul className="p-1.5">
              {history.length === 0 && <li className="p-2 text-[11px] text-muted-foreground">No queries yet.</li>}
              {history.map((h, i) => (
                <li key={i}>
                  <button className="num mb-1 w-full whitespace-pre-wrap break-all rounded border border-border/60 p-1.5 text-left text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDraft(h)}>
                    {h.length > 220 ? `${h.slice(0, 220)}…` : h}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </aside>
      <div className="flex min-h-0 flex-col">
        <div className="num flex items-center gap-3 border-b border-border px-3 py-1 text-[10.5px] text-muted-foreground">
          {running && <Spinner className="size-3" />}
          {result && !error && (
            <span data-testid="sql-stats">
              {formatInt(result.rowCount)} row{result.rowCount === 1 ? "" : "s"}
              {result.truncated ? " (truncated)" : ""} · {result.columns.length} cols · {formatMs(result.elapsedMs)}
              {result.statementCount > 1 ? ` · ${result.statementCount} statements` : ""}
            </span>
          )}
          {result && result.columns.length > 0 && (
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => void exportResult("csv")}>
                <Download /> CSV
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void exportResult("parquet")}>
                <Download /> Parquet
              </Button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {error ? (
            <pre role="alert" data-testid="sql-error" className="m-3 whitespace-pre-wrap rounded-md border border-critical/40 bg-critical/10 p-2 text-xs text-[#f08a8a]">
              {error}
            </pre>
          ) : result ? (
            <PanelErrorBoundary label="Results" resetKey={result}>
              <ResultsGrid columns={result.columns} rowCount={result.rowCount} />
            </PanelErrorBoundary>
          ) : (
            <div className="p-3 text-xs text-muted-foreground">Run a query to see results. Everything executes locally in DuckDB-WASM.</div>
          )}
        </div>
      </div>
    </div>
  );
}
