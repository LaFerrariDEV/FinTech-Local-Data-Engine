"use client";

import { AlertTriangle, FileUp, RotateCcw, ShieldCheck, Upload, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store/workbench";
import { ACCEPTED_EXTENSIONS, useIngest } from "./use-ingest";

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  reading: "Reading",
  parsing: "Parsing",
  normalizing: "Normalizing",
  done: "Finishing",
  failed: "Failed",
};

export function DropZone() {
  const { ingestFiles, ready } = useIngest();
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload CSV or Parquet files"
        data-testid="drop-zone"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          if (e.dataTransfer.files.length) void ingestFiles(e.dataTransfer.files);
        }}
        className={cn(
          "group flex cursor-pointer flex-col items-center gap-1.5 rounded-md border border-dashed border-input bg-panel/60 px-3 py-4 text-center transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          over && "border-primary bg-primary/10",
          !ready && "pointer-events-none opacity-50",
        )}
      >
        <Upload className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
        <div className="text-xs font-medium">Drop CSV / Parquet</div>
        <div className="text-[10.5px] text-muted-foreground">or click to browse · stays on this device</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="file-input"
          accept={ACCEPTED_EXTENSIONS.join(",")}
          onChange={(e) => {
            if (e.target.files?.length) void ingestFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <IngestJobs />
    </div>
  );
}

function IngestJobs() {
  const jobs = useWorkbench((s) => s.jobs);
  const removeJob = useWorkbench((s) => s.removeJob);
  const { ingestFile } = useIngest();
  if (jobs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-live="polite">
      {jobs.map((job) => (
        <li key={job.id} data-testid="ingest-job" className={cn("rounded-md border border-border bg-panel-2 p-2", job.error && "border-critical/40")}>
          <div className="flex items-center gap-2">
            {job.error ? <AlertTriangle className="size-3.5 shrink-0 text-critical" /> : <Spinner className="size-3" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{job.fileName}</div>
              <div className="num text-[10.5px] text-muted-foreground">
                {formatBytes(job.size)} · {PHASE_LABEL[job.phase] ?? job.phase}
              </div>
            </div>
            {job.error && (
              <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => removeJob(job.id)}>
                <X />
              </Button>
            )}
          </div>
          {job.error && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <p data-testid="ingest-error" className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10.5px] text-[#f08a8a]">
                {job.error}
              </p>
              <div className="flex gap-1.5">
                {job.errorCode === "MALFORMED_CSV" && job.file && (
                  <Button size="sm" variant="outline" onClick={() => void ingestFile(job.file!, { lenient: true, jobId: job.id })}>
                    <ShieldCheck /> Import &amp; quarantine bad rows
                  </Button>
                )}
                {job.errorCode !== "MALFORMED_CSV" && job.file && (
                  <Button size="sm" variant="ghost" onClick={() => void ingestFile(job.file!, { jobId: job.id })}>
                    <RotateCcw /> Retry
                  </Button>
                )}
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Full-window drop target so files can be dropped anywhere on the workbench. */
export function GlobalDropOverlay() {
  const { ingestFiles, ready } = useIngest();
  const [active, setActive] = React.useState(false);
  const depth = React.useRef(0);

  React.useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (e.dataTransfer?.files.length) void ingestFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [ingestFiles]);

  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary px-16 py-12">
        <FileUp className="size-8 text-primary" />
        <div className="text-base font-semibold">{ready ? "Drop to load into DuckDB" : "Engine is still starting…"}</div>
        <div className="text-xs text-muted-foreground">CSV, TSV or Parquet · parsed in a background worker · never uploaded</div>
      </div>
    </div>
  );
}
