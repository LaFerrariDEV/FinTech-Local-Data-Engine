import type { EngineInfo } from "../quant/types";
import type { EngineMethod, EngineMethods, RpcRequest, SerializedError, WorkerMessage } from "./protocol";

/** Error surfaced to the UI for any failed engine call. */
export class EngineCallError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(error: SerializedError) {
    super(error.message);
    this.name = "EngineCallError";
    this.code = error.code;
    this.details = error.details;
  }
}

export type EngineStatus = "idle" | "booting" | "ready" | "crashed" | "unresponsive" | "failed" | "disposed";

export interface EngineStatusSnapshot {
  status: EngineStatus;
  info: EngineInfo | null;
  error: string | null;
  restarts: number;
  pending: number;
}

/** The subset of the Worker API used by the client (injectable for tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: MessageEvent | ErrorEvent | Event) => void): void;
  terminate(): void;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (phase: string, detail?: Record<string, unknown>) => void;
}

export interface EngineClientOptions {
  createWorker: () => WorkerLike;
  init: EngineMethods["init"]["params"];
  bootTimeoutMs?: number;
  defaultTimeoutMs?: number;
  heartbeatMs?: number;
  /** Number of consecutive missed heartbeats before the engine is flagged unresponsive. */
  heartbeatMisses?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onProgress?: CallOptions["onProgress"];
  cleanup: () => void;
}

/**
 * Promise-based RPC client for the engine worker with crash detection, per-call timeouts,
 * cancellation, heartbeat liveness checks and explicit restart.
 */
export class EngineClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(s: EngineStatusSnapshot) => void>();
  private snapshot: EngineStatusSnapshot = { status: "idle", info: null, error: null, restarts: 0, pending: 0 };
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private generation = 0;
  private startPromise: Promise<EngineInfo> | null = null;

  constructor(private readonly options: EngineClientOptions) {}

  get status(): EngineStatusSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: EngineStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private setStatus(patch: Partial<EngineStatusSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, pending: this.pending.size };
    for (const l of this.listeners) l(this.snapshot);
  }

  start(): Promise<EngineInfo> {
    if (this.snapshot.status === "disposed") return Promise.reject(new Error("Engine client was disposed"));
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.setStatus({ status: "booting", error: null });
    let worker: WorkerLike;
    try {
      worker = this.options.createWorker();
    } catch (error) {
      const message = `Unable to start the engine worker: ${error instanceof Error ? error.message : String(error)}`;
      this.setStatus({ status: "failed", error: message });
      return Promise.reject(new Error(message));
    }
    this.worker = worker;
    worker.addEventListener("message", (event) => {
      if (generation === this.generation) this.onMessage((event as MessageEvent<WorkerMessage>).data);
    });
    worker.addEventListener("error", (event) => {
      if (generation !== this.generation) return;
      const e = event as ErrorEvent;
      if (typeof e.preventDefault === "function") e.preventDefault();
      this.onCrash(e.message ? `Engine worker crashed: ${e.message}` : "Engine worker crashed");
    });
    worker.addEventListener("messageerror", () => {
      if (generation === this.generation) this.onCrash("Engine worker sent an unreadable message");
    });
    const promise = this.call("init", this.options.init, { timeoutMs: this.options.bootTimeoutMs ?? 60_000 })
      .then((info) => {
        if (generation !== this.generation) throw new Error("Engine was restarted during boot");
        this.setStatus({ status: "ready", info, error: null });
        this.startHeartbeat(generation);
        return info;
      })
      .catch((error: Error) => {
        if (generation === this.generation) {
          this.setStatus({ status: this.snapshot.status === "crashed" ? "crashed" : "failed", error: error.message });
          this.teardownWorker();
        }
        this.startPromise = null;
        throw error;
      });
    this.startPromise = promise;
    return promise;
  }

  async restart(): Promise<EngineInfo> {
    this.teardownWorker();
    this.rejectAll(new EngineCallError({ name: "EngineRestarted", code: "RESTARTED", message: "Engine restarted" }));
    this.startPromise = null;
    this.setStatus({ restarts: this.snapshot.restarts + 1, info: null });
    return this.start();
  }

  dispose(): void {
    this.teardownWorker();
    this.rejectAll(new EngineCallError({ name: "EngineDisposed", code: "DISPOSED", message: "Engine disposed" }));
    this.startPromise = null;
    this.setStatus({ status: "disposed" });
    this.listeners.clear();
  }

  call<M extends EngineMethod>(method: M, params: EngineMethods[M]["params"], options: CallOptions = {}): Promise<EngineMethods[M]["result"]> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new EngineCallError({ name: "EngineUnavailable", code: "NOT_RUNNING", message: `Engine is ${this.snapshot.status}` }));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new EngineCallError({ name: "AbortError", code: "ABORTED", message: "Request aborted" }));
    }
    const id = this.nextId++;
    return new Promise<EngineMethods[M]["result"]>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 300_000;
      const onAbort = () => {
        this.settle(id)?.reject(new EngineCallError({ name: "AbortError", code: "ABORTED", message: "Request aborted" }));
        // Stop the in-flight query inside DuckDB as well.
        if (method === "query" || method === "export") void this.call("cancel", {} as never, { timeoutMs: 5_000 }).catch(() => undefined);
      };
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => {
              this.settle(id)?.reject(
                new EngineCallError({ name: "TimeoutError", code: "TIMEOUT", message: `Engine call "${method}" timed out after ${Math.round(timeoutMs / 1000)}s` }),
              );
            }, timeoutMs)
          : null;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        onProgress: options.onProgress,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort),
      });
      this.setStatus({});
      const message: RpcRequest<M> = { kind: "request", id, method, params };
      try {
        worker.postMessage(message);
      } catch (error) {
        this.settle(id)?.reject(
          new EngineCallError({ name: "DataCloneError", code: "SERIALIZE", message: `Could not send "${method}" to the engine: ${error instanceof Error ? error.message : String(error)}` }),
        );
      }
    });
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.cleanup();
    this.setStatus({});
    return entry;
  }

  private onMessage(message: WorkerMessage) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "progress") {
      this.pending.get(message.id)?.onProgress?.(message.phase, message.detail);
      return;
    }
    if (message.kind !== "response") return;
    const entry = this.settle(message.id);
    if (!entry) return;
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new EngineCallError(message.error));
  }

  private onCrash(reason: string) {
    this.teardownWorker();
    this.startPromise = null;
    this.rejectAll(new EngineCallError({ name: "EngineCrashed", code: "CRASHED", message: reason }));
    this.setStatus({ status: "crashed", error: reason, info: null });
  }

  private rejectAll(error: Error) {
    for (const id of Array.from(this.pending.keys())) this.settle(id)?.reject(error);
  }

  private teardownWorker() {
    this.generation++;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Already gone.
      }
    }
    this.worker = null;
  }

  private startHeartbeat(generation: number) {
    const every = this.options.heartbeatMs ?? 5_000;
    if (every <= 0) return;
    this.missed = 0;
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation) return;
      this.call("ping", {} as never, { timeoutMs: every })
        .then(() => {
          this.missed = 0;
          if (this.snapshot.status === "unresponsive") this.setStatus({ status: "ready", error: null });
        })
        .catch(() => {
          if (generation !== this.generation) return;
          this.missed++;
          if (this.missed >= (this.options.heartbeatMisses ?? 3) && this.snapshot.status === "ready") {
            this.setStatus({ status: "unresponsive", error: "The engine has stopped answering heartbeats" });
          }
        });
    }, every);
  }
}
