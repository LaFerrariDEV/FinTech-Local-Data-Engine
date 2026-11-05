import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

export async function openWorkbench(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready", { timeout: 90_000 });
}

export async function uploadFile(page: Page, name: string, contents: string | Buffer, mimeType = "text/csv"): Promise<void> {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.byteLength > 40 * 1024 * 1024) {
    // Playwright caps in-memory payloads at 50 MB; large fixtures go through a real file.
    const path = test.info().outputPath(name);
    writeFileSync(path, buffer);
    await page.getByTestId("file-input").setInputFiles(path);
    return;
  }
  await page.getByTestId("file-input").setInputFiles({ name, mimeType, buffer });
}

/** Waits until the (possibly re-booted) engine reports the requested storage backend. */
export async function waitForPersistence(page: Page, mode: "memory" | "opfs"): Promise<void> {
  await page.waitForFunction((m) => window.__quantagent?.client.status.status === "ready" && window.__quantagent.client.status.info?.persistence === m, mode, { timeout: 90_000 });
}

/** Runs read-only SQL through the app's engine handle and returns plain rows. */
export async function sql(page: Page, statement: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (s) => {
    const r = await window.__quantagent!.client.call("agentQuery", { sql: s, maxRows: 1000 });
    return r.rows;
  }, statement);
}

export async function waitForDataset(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId(`dataset-${name}`)).toBeVisible({ timeout: 180_000 });
}

/** Installs a requestAnimationFrame probe that records the longest gap between frames. */
export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: { max: number; count: number; running: boolean; longTasks: number } };
    w.__frames = { max: 0, count: 0, running: true, longTasks: 0 };
    let last = performance.now();
    const tick = (now: number) => {
      const gap = now - last;
      last = now;
      if (w.__frames.count > 2) w.__frames.max = Math.max(w.__frames.max, gap);
      w.__frames.count++;
      if (w.__frames.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__frames.longTasks += entry.duration;
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // Long Task API unavailable.
    }
  });
}

export async function stopFrameProbe(page: Page): Promise<{ max: number; count: number; longTasks: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: { max: number; count: number; running: boolean; longTasks: number } };
    w.__frames.running = false;
    return { max: w.__frames.max, count: w.__frames.count, longTasks: w.__frames.longTasks };
  });
}

export function ohlcvCsv(rows: number, options: { start?: number; step?: number; symbol?: string } = {}): string {
  const start = options.start ?? Date.UTC(2015, 0, 1) / 1000;
  const step = options.step ?? 86_400;
  const lines = [options.symbol ? "date,symbol,open,high,low,close,volume" : "date,open,high,low,close,volume"];
  let price = 100;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < rows; i++) {
    const open = price;
    const close = Math.max(1, open * (1 + (rand() - 0.5) * 0.04));
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const ts = new Date((start + i * step) * 1000).toISOString().replace("T", " ").slice(0, 19);
    const vol = Math.round(1000 + rand() * 100000);
    lines.push(
      options.symbol
        ? `${ts},${options.symbol},${open.toFixed(4)},${high.toFixed(4)},${low.toFixed(4)},${close.toFixed(4)},${vol}`
        : `${ts},${open.toFixed(4)},${high.toFixed(4)},${low.toFixed(4)},${close.toFixed(4)},${vol}`,
    );
    price = close;
  }
  return `${lines.join("\n")}\n`;
}
