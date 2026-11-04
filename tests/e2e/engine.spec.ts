import { expect, test } from "@playwright/test";
import { openWorkbench, sql, waitForPersistence } from "./helpers";

test.describe("DuckDB-WASM engine worker", () => {
  test("boots DuckDB inside a dedicated worker, off the main thread", async ({ page }) => {
    const started = Date.now();
    await openWorkbench(page);
    const bootWall = Date.now() - started;
    await expect(page.getByTestId("engine-status")).toContainText(/DuckDB v\d+\.\d+\.\d+/);

    // The engine worker (and the nested DuckDB worker) are separate threads.
    const workerUrls = page.workers().map((w) => w.url());
    expect(workerUrls.some((u) => u.includes("/_next/static/"))).toBe(true);
    expect(workerUrls.some((u) => u.includes("/duckdb/duckdb-browser-"))).toBe(true);

    // The main thread never loads the WASM binary itself.
    const mainThreadWasm = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".wasm")).length);
    expect(mainThreadWasm).toBe(0);

    const rows = await sql(page, "SELECT 40 + 2 AS answer, version() AS v");
    expect(rows[0].answer).toBe(42);
    expect(String(rows[0].v)).toMatch(/^v\d/);
    const info = await page.evaluate(() => window.__quantagent!.client.status.info);
    expect(info?.persistence).toBe("memory");
    test.info().annotations.push({ type: "boot", description: `engine ready after ${bootWall} ms (worker boot ${info?.bootMs} ms, bundle ${info?.bundle})` });
  });

  test("recovers from a worker crash with an explicit restart", async ({ page }) => {
    await openWorkbench(page, "?debug=1");
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();

    // A pending call must be rejected (not hang) when the worker dies.
    const outcome = page.evaluate(async () => {
      const c = window.__quantagent!.client;
      const slow = c.call("query", { sql: "SELECT count(*) FROM range(3000000000)" }).then(
        () => "resolved",
        (e: { code?: string }) => e.code ?? "error",
      );
      await c.call("debug:crash", {} as never);
      return slow;
    });
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "crashed");
    expect(await outcome).toBe("CRASHED");
    await expect(page.getByTestId("engine-error")).toContainText(/crashed/i);
    await expect(page.getByTestId("dataset-list")).toContainText("No datasets yet");

    await page.getByTestId("engine-restart").click();
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready");
    const rows = await sql(page, "SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
  });

  test("debug commands are disabled without ?debug", async ({ page }) => {
    await openWorkbench(page);
    const code = await page.evaluate(() => window.__quantagent!.client.call("debug:crash", {} as never).then(() => "ok", (e: { code: string }) => e.code));
    expect(code).toBe("FORBIDDEN");
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready");
  });

  test("surfaces a failed boot when the WASM runtime cannot be fetched", async ({ page }) => {
    await page.route("**/duckdb/*.wasm", (route) => route.fulfill({ status: 404, body: "missing" }));
    await page.goto("/");
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", /failed|crashed/, { timeout: 90_000 });
    await expect(page.getByTestId("engine-restart")).toBeVisible();
    await expect(page.getByTestId("engine-error")).toBeVisible();
    // The rest of the UI stays usable (no white screen).
    await expect(page.getByTestId("drop-zone")).toBeVisible();
    await page.unroute("**/duckdb/*.wasm");
    await page.getByTestId("engine-restart").click();
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready", { timeout: 90_000 });
  });

  test("persists datasets across reloads with OPFS when enabled", async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole("switch", { name: "Persist data across reloads" }).click();
    await waitForPersistence(page, "opfs");
    await expect(page.getByTestId("status-bar")).toContainText("OPFS persistent");
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    await page.reload();
    await waitForPersistence(page, "opfs");
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    const rows = await sql(page, "SELECT count(*) AS n FROM sample_equities_daily");
    expect(rows[0].n).toBe(7560);
    // Clean up so other tests start from an empty in-memory engine.
    await page.evaluate(() => window.__quantagent!.client.call("drop", { dataset: "sample_equities_daily" }));
    await page.getByRole("switch", { name: "Persist data across reloads" }).click();
    await waitForPersistence(page, "memory");
  });
});
