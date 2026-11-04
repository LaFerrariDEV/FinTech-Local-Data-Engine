import type { EngineInfo } from "../quant/types";
import { collectTransferables } from "./arrow-utils";
import { createBrowserDriver } from "./browser-driver";
import { EngineCore } from "./core";
import { EngineError, errorMessage } from "./driver";
import type { EngineMethod, EngineMethods, RpcRequest, SerializedError, WorkerMessage } from "./protocol";

/**
 * QuantAgent engine worker. Hosts DuckDB-WASM plus every CPU-heavy step of the pipeline
 * (parsing, normalization, resampling, indicator kernels, backtests, export encoding).
 * The UI thread only receives compact, transferable typed arrays.
 */

/** Minimal typing of the dedicated worker global (avoids mixing the DOM and WebWorker libs). */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RpcRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

let core: EngineCore | null = null;
let bootPromise: Promise<EngineInfo> | null = null;
let debugEnabled = false;

function post(message: WorkerMessage, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof EngineError) return { name: error.name, code: error.code, message: error.message, details: error.details };
  if (error instanceof Error) return { name: error.name, code: "INTERNAL", message: error.message };
  return { name: "Error", code: "INTERNAL", message: errorMessage(error) };
}

function requireCore(): EngineCore {
  if (!core) throw new EngineError("NOT_READY", "Engine is not initialized");
  return core;
}

async function boot(params: EngineMethods["init"]["params"]): Promise<EngineInfo> {
  const started = performance.now();
  debugEnabled = params.debug;
  const { driver, persistence, persistenceError } = await createBrowserDriver(params.assetBaseUrl, params.persist);
  const engine = new EngineCore(driver);
  const datasets = await engine.init();
  core = engine;
  return {
    duckdbVersion: await engine.version(),
    bundle: engine.bundle,
    persistence,
    persistenceError,
    bootMs: Math.round(performance.now() - started),
    datasets,
  };
}

async function dispatch(request: RpcRequest): Promise<unknown> {
  const { method, params, id } = request;
  const progress = (phase: string, detail?: Record<string, unknown>) => post({ kind: "progress", id, phase, detail });
  switch (method as EngineMethod) {
    case "init": {
      if (!bootPromise) {
        bootPromise = boot(params as EngineMethods["init"]["params"]);
        bootPromise.catch(() => {
          bootPromise = null;
        });
      }
      return bootPromise;
    }
    case "ping":
      return { now: Date.now() };
    case "datasets":
      return requireCore().listDatasets();
    case "ingest": {
      const p = params as EngineMethods["ingest"]["params"];
      return requireCore().ingest({ fileName: p.fileName, size: p.file.size, blob: p.file }, p.options ?? {}, progress);
    }
    case "sample":
      return requireCore().generateSample(params as EngineMethods["sample"]["params"], progress);
    case "remap": {
      const p = params as EngineMethods["remap"]["params"];
      return requireCore().remap(p.dataset, p.mapping);
    }
    case "drop":
      await requireCore().dropDataset((params as EngineMethods["drop"]["params"]).dataset);
      return { ok: true };
    case "bars":
      return requireCore().bars(params as EngineMethods["bars"]["params"]);
    case "query": {
      const p = params as EngineMethods["query"]["params"];
      return requireCore().runQuery(p.sql, p.maxRows);
    }
    case "agentQuery": {
      const p = params as EngineMethods["agentQuery"]["params"];
      return requireCore().agentQuery(p.sql, p.maxRows);
    }
    case "cancel":
      return { cancelled: await requireCore().cancel() };
    case "catalog":
      return requireCore().catalog();
    case "quality":
      return requireCore().quality((params as EngineMethods["quality"]["params"]).dataset);
    case "backtest":
      return requireCore().backtest(params as EngineMethods["backtest"]["params"]);
    case "export":
      return requireCore().exportData(params as EngineMethods["export"]["params"]);
    case "stats":
      return requireCore().stats();
    case "debug:crash":
      if (!debugEnabled) throw new EngineError("FORBIDDEN", "Debug commands are disabled");
      // Throw outside of any promise chain so it surfaces as an uncaught worker error.
      setTimeout(() => {
        throw new Error("Injected engine crash (debug)");
      }, 0);
      return { ok: true };
    default:
      throw new EngineError("UNKNOWN_METHOD", `Unknown engine method "${String(method)}"`);
  }
}

scope.addEventListener("message", (event: MessageEvent<RpcRequest>) => {
  const request = event.data;
  if (!request || request.kind !== "request") return;
  dispatch(request).then(
    (result) => {
      const transfer = Array.from(collectTransferables(result));
      post({ kind: "response", id: request.id, ok: true, result }, transfer);
    },
    (error) => post({ kind: "response", id: request.id, ok: false, error: serializeError(error) }),
  );
});
