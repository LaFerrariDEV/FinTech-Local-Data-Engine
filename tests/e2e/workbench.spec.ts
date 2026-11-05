import { expect, test, type Page } from "@playwright/test";
import { openWorkbench, sql, startFrameProbe, stopFrameProbe } from "./helpers";

async function heapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  await cdp.detach();
  return usedSize / (1024 * 1024);
}

test.describe("workbench UI", () => {
  test("charts with indicators and stays leak-free across repeated state changes", async ({ page }) => {
    await openWorkbench(page);
    await page.getByTestId("sample-intraday").click();
    await expect(page.getByTestId("dataset-sample_crypto_1m")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("chart-stats")).toBeVisible();

    const cycle = async () => {
      for (const tf of ["tf-1h", "tf-4h", "tf-1d", "tf-auto"]) {
        await page.getByTestId(tf).click();
        await expect(page.getByTestId("chart-stats")).toBeVisible();
      }
      await page.getByTestId("indicator-picker").click();
      await page.getByTestId("indicator-rsi_14").click();
      await page.getByTestId("indicator-macd_12_26_9").click();
      await page.getByTestId("indicator-bb_20_2").click();
      await page.keyboard.press("Escape");
      await page.getByTestId("symbol-select").click();
      await page.getByRole("option", { name: "ETHX" }).click();
      await page.getByTestId("tab-sql").click();
      await page.getByTestId("tab-chart").click();
      await expect(page.getByTestId("price-chart")).toBeVisible();
      await page.getByTestId("symbol-select").click();
      await page.getByRole("option", { name: "BTCX" }).click();
      // Toggle the same indicators off again.
      await page.getByTestId("indicator-picker").click();
      await page.getByTestId("indicator-rsi_14").click();
      await page.getByTestId("indicator-macd_12_26_9").click();
      await page.getByTestId("indicator-bb_20_2").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chart-stats")).toBeVisible();
    };

    // Warm-up (JIT, caches, lazily created chart internals), then measure.
    await cycle();
    await page.waitForTimeout(500);
    const canvasesBefore = await page.locator("canvas").count();
    const before = await heapMb(page);
    await startFrameProbe(page);
    for (let i = 0; i < 12; i++) await cycle();
    const frames = await stopFrameProbe(page);
    await page.waitForTimeout(1000);
    const after = await heapMb(page);
    const canvasesAfter = await page.locator("canvas").count();
    test.info().annotations.push({
      type: "memory",
      description: `JS heap ${before.toFixed(1)} MB -> ${after.toFixed(1)} MB after 12 cycles (${(after - before).toFixed(1)} MB); canvases ${canvasesBefore} -> ${canvasesAfter}; longest frame gap ${Math.round(frames.max)} ms`,
    });
    expect(canvasesAfter).toBe(canvasesBefore);
    expect(after - before).toBeLessThan(20);
    expect(frames.max).toBeLessThan(1000);

    // Legend reflects the hovered bar.
    const box = await page.getByTestId("price-chart").boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.3);
    await expect(page.getByTestId("chart-legend")).toContainText(/BTCX\s*O/);
  });

  test("SQL console runs scripts, reports errors, cancels long queries and recovers", async ({ page }) => {
    await openWorkbench(page);
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    await page.getByTestId("tab-sql").click();
    const editor = page.getByTestId("sql-editor");
    const setSql = async (text: string) => {
      await page.evaluate((t) => window.__quantagent!.store.getState().setSqlDraft(t), text);
      await expect(editor).toContainText(text.slice(0, 20));
    };

    await setSql("SELECT symbol, count(*) AS bars, round(avg(close), 2) AS avg_close FROM sample_equities_daily GROUP BY symbol ORDER BY symbol");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-stats")).toContainText("3 rows");
    await expect(page.getByTestId("results-grid")).toContainText("INITECH");

    // Keyboard shortcut.
    await setSql("SELECT 1 AS one");
    await editor.click();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("sql-stats")).toContainText("1 row");

    await setSql("SELECT * FROM missing_table");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-error")).toContainText(/missing_table/);

    // Long-running query is cancellable and the connection stays usable afterwards.
    await setSql("SELECT count(*) AS n FROM range(100000000000) a");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-cancel")).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByTestId("sql-cancel").click();
    await expect(page.getByTestId("sql-error")).toContainText(/aborted/i);
    await setSql("SELECT 2 AS two");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-stats")).toContainText("1 row", { timeout: 60_000 });

    // Large results are virtualized: only a window of rows is in the DOM.
    await setSql("SELECT * FROM range(50000) t(i)");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("sql-stats")).toContainText("50,000 rows");
    const domRows = await page.locator("[data-testid=results-grid] [role=row]").count();
    expect(domRows).toBeLessThan(200);

    // DDL from the console updates the catalog and dataset list.
    await setSql("DROP TABLE sample_equities_daily");
    await page.getByTestId("sql-run").click();
    await expect(page.getByTestId("dataset-list")).toContainText("No datasets yet");
  });

  test("backtests a strategy and renders analytics", async ({ page }) => {
    await openWorkbench(page);
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    await page.getByTestId("tab-backtest").click();
    await page.getByTestId("backtest-run").click();
    const results = page.getByTestId("backtest-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("Total return");
    await expect(page.getByTestId("equity-chart")).toBeVisible();
    await expect(results).toContainText("Monthly returns");
    await expect(results).toContainText(/LONG/);

    // Custom SQL strategy, including validation of a write attempt.
    await page.getByTestId("strategy-select").click();
    await page.getByRole("option", { name: "Custom SQL signal" }).click();
    await page.getByLabel("Custom signal SQL").fill("DELETE FROM sample_equities_daily");
    await page.getByTestId("backtest-run").click();
    await expect(page.getByRole("alert").filter({ hasText: /Rejected SQL/ })).toBeVisible();
    const [{ n }] = await sql(page, "SELECT count(*) AS n FROM sample_equities_daily");
    expect(n).toBe(7560);
    await page.getByLabel("Custom signal SQL").fill("SELECT ts, CASE WHEN close > avg(close) OVER (ORDER BY ts ROWS 99 PRECEDING) THEN 1 ELSE 0 END AS position FROM bars");
    await page.getByTestId("backtest-run").click();
    await expect(results).toContainText("Custom SQL signal");
  });

  test("audits data quality", async ({ page }) => {
    const lines = ["date,open,high,low,close,volume"];
    for (let i = 0; i < 300; i++) {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const high = i === 10 ? 90 : 101;
      const close = i === 20 ? -1 : 100 + (i % 3);
      lines.push(`${d},100,${high},99,${close},${i === 30 ? -5 : 1000}`);
    }
    lines.push(lines[5].replace(",1000", ",2000")); // duplicate timestamp
    await openWorkbench(page);
    await page.getByTestId("file-input").setInputFiles({ name: "dirty.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) });
    await expect(page.getByTestId("dataset-dirty")).toBeVisible();
    await page.getByTestId("tab-quality").click();
    await expect(page.getByTestId("issue-ohlc_violation")).toBeVisible();
    await expect(page.getByTestId("issue-non_positive")).toBeVisible();
    await expect(page.getByTestId("issue-negative_volume")).toBeVisible();
    await expect(page.getByTestId("issue-duplicates")).toBeVisible();
    const score = Number(await page.getByTestId("quality-score").textContent());
    expect(score).toBeLessThan(80);
  });
});
