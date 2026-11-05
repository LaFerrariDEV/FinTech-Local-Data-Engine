"use client";

import { create } from "zustand";
import { DEFAULT_INDICATORS } from "@/lib/quant/indicators";
import type { BacktestResult, DatasetInfo, IndicatorSpec, Timeframe } from "@/lib/quant/types";

export type WorkbenchTab = "chart" | "sql" | "backtest" | "quality";

export interface IngestJob {
  id: string;
  fileName: string;
  size: number;
  phase: string;
  startedAt: number;
  error?: string;
  errorCode?: string;
  /** Kept so a failed strict import can be retried in lenient mode. */
  file?: File;
}

interface WorkbenchState {
  datasets: DatasetInfo[];
  activeDataset: string | null;
  activeSymbol: string | null;
  timeframe: Timeframe;
  indicators: IndicatorSpec[];
  tab: WorkbenchTab;
  agentOpen: boolean;
  jobs: IngestJob[];
  sqlDraft: string;
  sqlHistory: string[];
  mappingDialogFor: string | null;
  backtest: BacktestResult | null;

  setBacktest: (result: BacktestResult | null) => void;
  setDatasets: (datasets: DatasetInfo[]) => void;
  upsertDataset: (dataset: DatasetInfo, activate?: boolean) => void;
  removeDataset: (name: string) => void;
  setActive: (name: string | null, symbol?: string | null) => void;
  setSymbol: (symbol: string | null) => void;
  setTimeframe: (tf: Timeframe) => void;
  setIndicators: (indicators: IndicatorSpec[]) => void;
  setTab: (tab: WorkbenchTab) => void;
  setAgentOpen: (open: boolean) => void;
  addJob: (job: IngestJob) => void;
  updateJob: (id: string, patch: Partial<IngestJob>) => void;
  removeJob: (id: string) => void;
  setSqlDraft: (sql: string) => void;
  pushHistory: (sql: string) => void;
  openMappingDialog: (dataset: string | null) => void;
}

const HISTORY_KEY = "quantagent.sqlHistory";

function loadHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  datasets: [],
  activeDataset: null,
  activeSymbol: null,
  timeframe: "auto",
  indicators: DEFAULT_INDICATORS,
  tab: "chart",
  agentOpen: true,
  jobs: [],
  sqlDraft: "",
  sqlHistory: loadHistory(),
  mappingDialogFor: null,
  backtest: null,

  setBacktest: (backtest) => set({ backtest }),
  setDatasets: (datasets) =>
    set((s) => {
      const active = s.activeDataset && datasets.some((d) => d.name === s.activeDataset) ? s.activeDataset : (datasets[0]?.name ?? null);
      const ds = datasets.find((d) => d.name === active);
      return {
        datasets,
        activeDataset: active,
        activeSymbol: ds && s.activeSymbol && ds.symbols.includes(s.activeSymbol) ? s.activeSymbol : (ds?.symbols[0] ?? null),
      };
    }),
  upsertDataset: (dataset, activate = true) =>
    set((s) => {
      const others = s.datasets.filter((d) => d.name !== dataset.name);
      const datasets = [dataset, ...others];
      if (!activate) return { datasets };
      return { datasets, activeDataset: dataset.name, activeSymbol: dataset.symbols[0] ?? null };
    }),
  removeDataset: (name) =>
    set((s) => {
      const datasets = s.datasets.filter((d) => d.name !== name);
      if (s.activeDataset !== name) return { datasets };
      return { datasets, activeDataset: datasets[0]?.name ?? null, activeSymbol: datasets[0]?.symbols[0] ?? null };
    }),
  setActive: (name, symbol) => {
    const ds = get().datasets.find((d) => d.name === name);
    set({ activeDataset: name, activeSymbol: symbol ?? ds?.symbols[0] ?? null });
  },
  setSymbol: (symbol) => set({ activeSymbol: symbol }),
  setTimeframe: (timeframe) => set({ timeframe }),
  setIndicators: (indicators) => set({ indicators }),
  setTab: (tab) => set({ tab }),
  setAgentOpen: (agentOpen) => set({ agentOpen }),
  addJob: (job) => set((s) => ({ jobs: [...s.jobs, job] })),
  updateJob: (id, patch) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  setSqlDraft: (sqlDraft) => set({ sqlDraft }),
  pushHistory: (sql) =>
    set((s) => {
      const trimmed = sql.trim();
      if (!trimmed) return {};
      const sqlHistory = [trimmed, ...s.sqlHistory.filter((h) => h !== trimmed)].slice(0, 50);
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(sqlHistory));
      } catch {
        // Storage may be unavailable (private mode); history then lives for the session only.
      }
      return { sqlHistory };
    }),
  openMappingDialog: (mappingDialogFor) => set({ mappingDialogFor }),
}));

export function useActiveDataset(): DatasetInfo | null {
  return useWorkbench((s) => s.datasets.find((d) => d.name === s.activeDataset) ?? null);
}
