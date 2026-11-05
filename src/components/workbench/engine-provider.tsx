"use client";

import * as React from "react";
import { EngineClient, type EngineStatusSnapshot } from "@/lib/engine/client";
import { useWorkbench } from "@/store/workbench";

const PERSIST_KEY = "quantagent.persist";

interface EngineContextValue {
  client: EngineClient | null;
  status: EngineStatusSnapshot;
  persist: boolean;
  setPersist: (persist: boolean) => void;
  restart: () => void;
}

const initialStatus: EngineStatusSnapshot = { status: "idle", info: null, error: null, restarts: 0, pending: 0 };
const EngineContext = React.createContext<EngineContextValue | null>(null);

function readPersist(): boolean {
  try {
    return window.localStorage.getItem(PERSIST_KEY) === "1";
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    /** Debug/automation handle (also used by the end-to-end test suite). */
    __quantagent?: { client: EngineClient; store: typeof useWorkbench };
  }
}

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = React.useState<EngineClient | null>(null);
  const [status, setStatus] = React.useState<EngineStatusSnapshot>(initialStatus);
  const [persist, setPersistState] = React.useState(false);
  const [generation, setGeneration] = React.useState(0);
  const setDatasets = useWorkbench((s) => s.setDatasets);

  React.useEffect(() => {
    setPersistState(readPersist());
  }, []);

  React.useEffect(() => {
    const debug = new URLSearchParams(window.location.search).has("debug");
    const persistNow = readPersist();
    const engine = new EngineClient({
      createWorker: () => new Worker(new URL("../../lib/engine/engine.worker.ts", import.meta.url), { type: "module", name: "quantagent-engine" }),
      // NEXT_PUBLIC_BASE_PATH is inlined at build time (e.g. "/FinTech-Local-Data-Engine" on GitHub Pages).
      init: { assetBaseUrl: `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/duckdb`, persist: persistNow, debug },
      bootTimeoutMs: 90_000,
      heartbeatMs: 5_000,
    });
    let previous: EngineStatusSnapshot["status"] | null = null;
    const unsubscribe = engine.subscribe((snapshot) => {
      setStatus(snapshot);
      // Sync the dataset list only on the transition into "ready" (boot or restart). Later
      // snapshots (pending-count changes, heartbeats) must not overwrite datasets loaded since.
      if (snapshot.status === "ready" && previous !== "ready" && previous !== "unresponsive" && snapshot.info) setDatasets(snapshot.info.datasets);
      if (snapshot.status === "crashed" && previous !== "crashed") setDatasets([]);
      previous = snapshot.status;
    });
    setClient(engine);
    window.__quantagent = { client: engine, store: useWorkbench };
    engine.start().catch(() => {
      // Status (failed/crashed) is surfaced through the subscription.
    });
    return () => {
      unsubscribe();
      // Reset immediately so no component can send work to the engine being torn down.
      setClient((current) => (current === engine ? null : current));
      setStatus(initialStatus);
      engine.dispose();
      if (window.__quantagent?.client === engine) delete window.__quantagent;
    };
  }, [generation, setDatasets]);

  const restart = React.useCallback(() => {
    if (!client) return;
    client.restart().catch(() => undefined);
  }, [client]);

  const setPersist = React.useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(PERSIST_KEY, value ? "1" : "0");
    } catch {
      // Without storage the preference only lasts until reload.
    }
    setPersistState(value);
    // Re-boot the engine with the new storage backend.
    setGeneration((g) => g + 1);
  }, []);

  const value = React.useMemo(() => ({ client, status, persist, setPersist, restart }), [client, status, persist, setPersist, restart]);
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const ctx = React.useContext(EngineContext);
  if (!ctx) throw new Error("useEngine must be used inside <EngineProvider>");
  return ctx;
}

/** Returns the client only when the engine is ready to accept work. */
export function useReadyClient(): EngineClient | null {
  const { client, status } = useEngine();
  return status.status === "ready" || status.status === "unresponsive" ? client : null;
}
