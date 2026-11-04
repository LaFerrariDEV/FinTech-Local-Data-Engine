"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { formatNumber } from "@/lib/format";
import type { ResultColumn } from "@/lib/quant/types";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 24;

function cellText(col: ResultColumn, row: number): { text: string; isNull: boolean } {
  if (col.numbers) {
    const v = col.numbers[row];
    if (Number.isNaN(v)) return { text: "NULL", isNull: true };
    if (col.kind === "timestamp") {
      const iso = new Date(v).toISOString();
      return { text: iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace("T", " ").replace(".000Z", "").replace("Z", ""), isNull: false };
    }
    if (col.kind === "date") return { text: new Date(v).toISOString().slice(0, 10), isNull: false };
    return { text: Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : formatNumber(v, 6), isNull: false };
  }
  const v = col.values?.[row];
  if (v == null) return { text: "NULL", isNull: true };
  return { text: typeof v === "boolean" ? String(v) : v.length > 400 ? `${v.slice(0, 400)}…` : v, isNull: false };
}

/** Virtualized result table: renders only visible rows, so 100k-row results stay smooth. */
export function ResultsGrid({ columns, rowCount }: { columns: ResultColumn[]; rowCount: number }) {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const widths = React.useMemo(
    () =>
      columns.map((c) => {
        let max = c.name.length + 4;
        const sample = Math.min(rowCount, 200);
        for (let i = 0; i < sample; i++) max = Math.max(max, Math.min(48, cellText(c, i).text.length));
        return Math.min(360, Math.max(72, max * 7.2 + 16));
      }),
    [columns, rowCount],
  );
  const total = widths.reduce((a, b) => a + b, 48);
  const virtualizer = useVirtualizer({ count: rowCount, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });

  if (columns.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">Statement executed. No rows returned.</div>;
  }

  return (
    <div ref={parentRef} className="num h-full min-h-0 overflow-auto text-[11.5px]" data-testid="results-grid" role="table" aria-rowcount={rowCount}>
      <div style={{ width: total, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b border-border bg-panel-2" role="row">
          <div className="w-12 shrink-0 px-2 py-1 text-right text-muted-foreground/60">#</div>
          {columns.map((c, i) => (
            <div key={c.name + i} role="columnheader" style={{ width: widths[i] }} className="shrink-0 truncate border-l border-border px-2 py-1" title={`${c.name} · ${c.type}`}>
              <span className="font-semibold text-foreground">{c.name}</span>
              <span className="ml-1.5 text-[10px] text-muted-foreground">{c.type.replace(/<.*>/, "")}</span>
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              role="row"
              className={cn("absolute left-0 flex w-full border-b border-border/50 hover:bg-accent/60", item.index % 2 === 1 && "bg-white/[0.012]")}
              style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              <div className="w-12 shrink-0 px-2 py-1 text-right text-muted-foreground/50">{item.index + 1}</div>
              {columns.map((c, i) => {
                const { text, isNull } = cellText(c, item.index);
                return (
                  <div
                    key={c.name + i}
                    role="cell"
                    style={{ width: widths[i] }}
                    className={cn("shrink-0 truncate border-l border-border/50 px-2 py-1", c.kind === "number" && "text-right", isNull && "italic text-muted-foreground/50")}
                    title={text.length > 30 ? text : undefined}
                  >
                    {text}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
