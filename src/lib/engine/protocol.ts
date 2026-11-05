import type {
  BacktestRequest,
  BacktestResult,
  BarsRequest,
  BarsResult,
  CatalogTable,
  ColumnMapping,
  DatasetInfo,
  EngineInfo,
  EngineStats,
  QualityReport,
  QueryResult,
} from "../quant/types";
import type { ExportRequest, ExportResult, IngestOptions, SampleOptions } from "./core";

/** Typed RPC surface between the UI thread and the engine worker. */
export interface EngineMethods {
  init: { params: { assetBaseUrl: string; persist: boolean; debug: boolean }; result: EngineInfo };
  ping: { params: Record<string, never>; result: { now: number } };
  datasets: { params: Record<string, never>; result: DatasetInfo[] };
  ingest: { params: { file: File | Blob; fileName: string; options?: IngestOptions }; result: DatasetInfo };
  sample: { params: SampleOptions; result: DatasetInfo };
  remap: { params: { dataset: string; mapping: ColumnMapping }; result: DatasetInfo };
  drop: { params: { dataset: string }; result: { ok: true } };
  bars: { params: BarsRequest; result: BarsResult };
  query: { params: { sql: string; maxRows?: number }; result: QueryResult };
  agentQuery: {
    params: { sql: string; maxRows?: number };
    result: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; elapsedMs: number };
  };
  cancel: { params: Record<string, never>; result: { cancelled: boolean } };
  catalog: { params: Record<string, never>; result: CatalogTable[] };
  quality: { params: { dataset: string }; result: QualityReport };
  backtest: { params: BacktestRequest; result: BacktestResult };
  export: { params: ExportRequest; result: ExportResult };
  stats: { params: Record<string, never>; result: EngineStats };
  "debug:crash": { params: Record<string, never>; result: { ok: true } };
}

export type EngineMethod = keyof EngineMethods;

export interface RpcRequest<M extends EngineMethod = EngineMethod> {
  kind: "request";
  id: number;
  method: M;
  params: EngineMethods[M]["params"];
}

export interface RpcSuccess {
  kind: "response";
  id: number;
  ok: true;
  result: unknown;
}

export interface SerializedError {
  name: string;
  code: string;
  message: string;
  details?: unknown;
}

export interface RpcFailure {
  kind: "response";
  id: number;
  ok: false;
  error: SerializedError;
}

export interface RpcProgress {
  kind: "progress";
  id: number;
  phase: string;
  detail?: Record<string, unknown>;
}

export type WorkerMessage = RpcSuccess | RpcFailure | RpcProgress;
