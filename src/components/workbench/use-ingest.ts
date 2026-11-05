"use client";

import * as React from "react";
import { toast } from "sonner";
import { EngineCallError } from "@/lib/engine/client";
import { formatInt, formatMs } from "@/lib/format";
import { useWorkbench } from "@/store/workbench";
import { useEngine } from "./engine-provider";

export const ACCEPTED_EXTENSIONS = [".csv", ".tsv", ".txt", ".psv", ".parquet", ".pq"];
/** WASM32 caps addressable memory at 4 GB; leave headroom for query execution. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function useIngest() {
  const { client, status } = useEngine();
  const { addJob, updateJob, removeJob, upsertDataset } = useWorkbench.getState();

  const ingestFile = React.useCallback(
    async (file: File, options: { lenient?: boolean; jobId?: string } = {}) => {
      if (!client || (status.status !== "ready" && status.status !== "unresponsive")) {
        toast.error("The engine is not ready yet.");
        return;
      }
      if (!isAcceptedFile(file)) {
        toast.error(`${file.name}: unsupported file type`, { description: `Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}` });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is too large`, { description: "Files up to 2 GB can be loaded into in-browser memory." });
        return;
      }
      const id = options.jobId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (options.jobId) updateJob(id, { phase: "queued", error: undefined, errorCode: undefined, startedAt: Date.now() });
      else addJob({ id, fileName: file.name, size: file.size, phase: "queued", startedAt: Date.now(), file });
      try {
        const ds = await client.call(
          "ingest",
          { file, fileName: file.name, options: { lenient: options.lenient } },
          { timeoutMs: 30 * 60_000, onProgress: (phase) => updateJob(id, { phase }) },
        );
        removeJob(id);
        upsertDataset(ds, true);
        const extra = ds.rejected.count ? ` · ${formatInt(ds.rejected.count)} rows quarantined` : "";
        toast.success(`Loaded ${ds.name}`, { description: `${formatInt(ds.rows)} rows in ${formatMs(ds.ingestMs)}${extra}` });
        if (!ds.chartable) {
          toast.warning(`${ds.name}: no timestamp/price columns detected`, { description: "Open the column mapping to enable charts and backtests." });
        }
      } catch (error) {
        const code = error instanceof EngineCallError ? error.code : "INTERNAL";
        const message = error instanceof Error ? error.message : String(error);
        updateJob(id, { phase: "failed", error: message, errorCode: code });
      }
    },
    [client, status.status, addJob, updateJob, removeJob, upsertDataset],
  );

  const ingestFiles = React.useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) await ingestFile(file);
    },
    [ingestFile],
  );

  return { ingestFile, ingestFiles, ready: status.status === "ready" || status.status === "unresponsive" };
}
