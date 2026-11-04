import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineCallError, EngineClient, type WorkerLike } from "../../src/lib/engine/client";
import type { RpcRequest, WorkerMessage } from "../../src/lib/engine/protocol";

type Listener = (event: MessageEvent | ErrorEvent | Event) => void;

/** In-memory stand-in for the engine worker. */
class FakeWorker implements WorkerLike {
  listeners: Record<string, Listener[]> = {};
  sent: RpcRequest[] = [];
  terminated = false;
  constructor(private readonly behavior: (req: RpcRequest, w: FakeWorker) => void) {}
  postMessage(message: unknown) {
    if (this.terminated) return;
    const req = message as RpcRequest;
    this.sent.push(req);
    queueMicrotask(() => this.behavior(req, this));
  }
  addEventListener(type: "message" | "error" | "messageerror", listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  terminate() {
    this.terminated = true;
  }
  emit(message: WorkerMessage) {
    if (this.terminated) return;
    for (const l of this.listeners.message ?? []) l({ data: message } as MessageEvent);
  }
  crash(message: string) {
    for (const l of this.listeners.error ?? []) l({ message, preventDefault() {} } as unknown as ErrorEvent);
  }
}

const info = { duckdbVersion: "v1.5.4", bundle: "eh", persistence: "memory", persistenceError: null, bootMs: 5, datasets: [] };

function healthy(req: RpcRequest, w: FakeWorker) {
  if (req.method === "init") w.emit({ kind: "response", id: req.id, ok: true, result: info });
  else if (req.method === "ping") w.emit({ kind: "response", id: req.id, ok: true, result: { now: Date.now() } });
  else if (req.method === "stats") {
    w.emit({ kind: "progress", id: req.id, phase: "working" });
    w.emit({ kind: "response", id: req.id, ok: true, result: { memoryBytes: 1, wasmHeapBytes: null, tables: 0 } });
  } else if (req.method === "query") w.emit({ kind: "response", id: req.id, ok: false, error: { name: "EngineError", code: "QUERY_FAILED", message: "boom" } });
  // other methods never answer (used for timeout/abort tests)
}

describe("EngineClient", () => {
  let workers: FakeWorker[];
  let client: EngineClient;
  const make = (behavior = healthy, extra: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}) => {
    client = new EngineClient({
      createWorker: () => {
        const w = new FakeWorker(behavior);
        workers.push(w);
        return w;
      },
      init: { assetBaseUrl: "http://x/duckdb", persist: false, debug: false },
      heartbeatMs: 0,
      ...extra,
    });
    return client;
  };

  beforeEach(() => {
    workers = [];
  });
  afterEach(() => client?.dispose());

  it("boots, reports status transitions and resolves calls with progress", async () => {
    const c = make();
    const statuses: string[] = [];
    c.subscribe((s) => statuses.push(s.status));
    await expect(c.start()).resolves.toMatchObject({ duckdbVersion: "v1.5.4" });
    expect(statuses).toContain("booting");
    expect(c.status.status).toBe("ready");
    const phases: string[] = [];
    await expect(c.call("stats", {} as never, { onProgress: (p) => phases.push(p) })).resolves.toMatchObject({ tables: 0 });
    expect(phases).toEqual(["working"]);
    expect(c.status.pending).toBe(0);
  });

  it("start() is idempotent while booting", async () => {
    const c = make();
    const [a, b] = [c.start(), c.start()];
    expect(a).toBe(b);
    await a;
    expect(workers).toHaveLength(1);
  });

  it("maps worker errors to EngineCallError with code", async () => {
    const c = make();
    await c.start();
    const err = await c.call("query", { sql: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineCallError);
    expect(err.code).toBe("QUERY_FAILED");
  });

  it("rejects all pending calls when the worker crashes, then recovers on restart", async () => {
    const c = make();
    await c.start();
    const pending = [c.call("bars", { dataset: "x", timeframe: "auto" }), c.call("catalog", {} as never)];
    workers[0].crash("Out of memory");
    for (const p of pending) await expect(p).rejects.toMatchObject({ code: "CRASHED" });
    expect(c.status.status).toBe("crashed");
    expect(c.status.error).toMatch(/Out of memory/);
    expect(workers[0].terminated).toBe(true);
    await expect(c.call("stats", {} as never)).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await c.restart();
    expect(c.status.status).toBe("ready");
    expect(c.status.restarts).toBe(1);
    await expect(c.call("stats", {} as never)).resolves.toBeTruthy();
  });

  it("fails boot cleanly when the worker cannot be created", async () => {
    client = new EngineClient({
      createWorker: () => {
        throw new Error("Workers are disabled");
      },
      init: { assetBaseUrl: "x", persist: false, debug: false },
    });
    await expect(client.start()).rejects.toThrow(/Workers are disabled/);
    expect(client.status.status).toBe("failed");
  });

  it("fails boot when init errors", async () => {
    const c = make((req, w) => {
      if (req.method === "init") w.emit({ kind: "response", id: req.id, ok: false, error: { name: "Error", code: "INTERNAL", message: "WASM failed to compile" } });
    });
    await expect(c.start()).rejects.toThrow(/WASM failed/);
    expect(c.status.status).toBe("failed");
    expect(workers[0].terminated).toBe(true);
  });

  describe("timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("times out calls and supports abort signals", async () => {
      const c = make();
      const boot = c.start();
      await vi.runAllTicks();
      await boot;
      const slow = c.call("catalog", {} as never, { timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);
      await expect(slow).rejects.toMatchObject({ code: "TIMEOUT" });
      const controller = new AbortController();
      const aborted = c.call("quality", { dataset: "x" }, { signal: controller.signal });
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
      expect(c.status.pending).toBe(0);
    });

    it("flags an unresponsive engine after missed heartbeats and recovers", async () => {
      let answerPings = true;
      const c = make(
        (req, w) => {
          if (req.method === "ping" && !answerPings) return;
          healthy(req, w);
        },
        { heartbeatMs: 100, heartbeatMisses: 2 },
      );
      const boot = c.start();
      await vi.runAllTicks();
      await boot;
      answerPings = false;
      await vi.advanceTimersByTimeAsync(450);
      expect(c.status.status).toBe("unresponsive");
      answerPings = true;
      await vi.advanceTimersByTimeAsync(250);
      expect(c.status.status).toBe("ready");
    });
  });

  it("dispose terminates the worker and rejects pending work", async () => {
    const c = make();
    await c.start();
    const p = c.call("catalog", {} as never);
    c.dispose();
    await expect(p).rejects.toMatchObject({ code: "DISPOSED" });
    expect(workers[0].terminated).toBe(true);
    expect(c.status.status).toBe("disposed");
  });
});
