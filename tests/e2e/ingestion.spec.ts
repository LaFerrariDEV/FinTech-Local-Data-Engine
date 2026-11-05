import { expect, test } from "@playwright/test";
import { parquetWriteBuffer } from "hyparquet-writer";
import { ohlcvCsv, openWorkbench, sql, startFrameProbe, stopFrameProbe, uploadFile, waitForDataset } from "./helpers";

test.describe("ingestion", () => {
  test("loads a 1,000,000-row CSV without dropping rows or freezing the UI", async ({ page }) => {
    const rows = 1_000_000;
    const csv = ohlcvCsv(rows, { start: Date.UTC(2023, 0, 1) / 1000, step: 60 });
    await openWorkbench(page);
    await startFrameProbe(page);
    const t0 = Date.now();
    await uploadFile(page, "ticks_1m.csv", csv);
    await waitForDataset(page, "ticks_1m");
    await expect(page.getByTestId("chart-stats")).toBeVisible({ timeout: 120_000 });
    const elapsed = Date.now() - t0;
    const frames = await stopFrameProbe(page);

    const [{ n, raw }] = await sql(page, "SELECT (SELECT count(*) FROM ticks_1m) AS n, (SELECT count(*) FROM ticks_1m_raw) AS raw");
    expect(n).toBe(rows);
    expect(raw).toBe(rows);
    const [{ first, last }] = await sql(page, "SELECT min(ts)::VARCHAR AS first, max(ts)::VARCHAR AS last FROM ticks_1m");
    expect(first).toBe("2023-01-01 00:00:00");
    expect(last).toBe(new Date((Date.UTC(2023, 0, 1) / 1000 + (rows - 1) * 60) * 1000).toISOString().replace("T", " ").slice(0, 19));

    // The chart was resampled in the worker to stay under the 20k-bar render budget.
    const stats = await page.getByTestId("chart-stats").textContent();
    const bars = Number(stats!.split(" ")[0].replace(/,/g, ""));
    expect(bars).toBeLessThanOrEqual(20_000);

    // Main thread stayed responsive while 1M rows were parsed, normalized and charted.
    test.info().annotations.push({ type: "perf", description: `1M rows ingested+charted in ${elapsed} ms; longest frame gap ${Math.round(frames.max)} ms; long tasks ${Math.round(frames.longTasks)} ms over ${frames.count} frames` });
    expect(frames.count).toBeGreaterThan(20);
    expect(frames.max).toBeLessThan(500);
  });

  test("accepts real drag-and-drop on the drop zone and anywhere on the window", async ({ page }) => {
    await openWorkbench(page);
    const drop = async (selector: string, name: string, csv: string) => {
      const dataTransfer = await page.evaluateHandle(
        ({ n, text }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([text], n, { type: "text/csv" }));
          return dt;
        },
        { n: name, text: csv },
      );
      await page.dispatchEvent(selector, "dragenter", { dataTransfer });
      await page.dispatchEvent(selector, "dragover", { dataTransfer });
      await page.dispatchEvent(selector, "drop", { dataTransfer });
    };
    await drop("[data-testid=drop-zone]", "zone_drop.csv", ohlcvCsv(250));
    await waitForDataset(page, "zone_drop");
    // Dropping onto the chart area uses the full-window drop target.
    await drop("main", "window_drop.csv", ohlcvCsv(300));
    await waitForDataset(page, "window_drop");
    const [r] = await sql(page, "SELECT (SELECT count(*) FROM zone_drop) AS a, (SELECT count(*) FROM window_drop) AS b");
    expect(r).toEqual({ a: 250, b: 300 });
    // Each file is ingested exactly once (no double handling by the zone and window listeners).
    const names = await page.evaluate(() => window.__quantagent!.store.getState().datasets.map((d) => d.name).sort());
    expect(names).toEqual(["window_drop", "zone_drop"]);
  });

  test("keeps very long lines and quoted multi-line fields intact", async ({ page }) => {
    const big = "x".repeat(6 * 1024 * 1024);
    const lines = ["date,close,note"];
    for (let i = 0; i < 500; i++) {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const note = i === 100 ? big : i % 9 === 0 ? '"line one\nline two, with ""quotes"""' : `n${i}`;
      lines.push(`${d},${100 + i},${note}`);
    }
    await openWorkbench(page);
    await uploadFile(page, "long_lines.csv", lines.join("\n"));
    await waitForDataset(page, "long_lines");
    const [r] = await sql(page, "SELECT count(*) AS n, max(length(note)) AS longest, count(*) FILTER (WHERE note LIKE 'line one%') AS multi FROM long_lines_raw");
    expect(r.n).toBe(500);
    expect(r.longest).toBe(big.length);
    expect(r.multi).toBe(56);
  });

  test("rejects malformed CSV strictly, then quarantines bad rows on request", async ({ page }) => {
    const csv = "date,open,high,low,close,volume\n2024-01-01,1,2,0.5,1.5,10\n2024-01-02,1,2,0.5,1.6,10,EXTRA\n2024-01-03,1,2,0.5,1.7,10\n2024-01-04,1,2,0.5,1.8,10\n";
    await openWorkbench(page);
    await uploadFile(page, "broken.csv", csv);
    await expect(page.getByTestId("ingest-error")).toContainText(/lenient|could not be parsed|dialect/i);
    await page.getByRole("button", { name: /quarantine bad rows/i }).click();
    await waitForDataset(page, "broken");
    const [r] = await sql(page, "SELECT count(*) AS n FROM broken");
    expect(r.n).toBe(3);
    await page.getByTestId("tab-quality").click();
    await expect(page.getByTestId("issue-rejected")).toContainText("Malformed CSV rows quarantined");
  });

  test("rejects unsupported and empty files with clear errors", async ({ page }) => {
    await openWorkbench(page);
    await uploadFile(page, "notes.docx", "PK\u0003\u0004", "application/octet-stream");
    await expect(page.getByText(/unsupported file type/i)).toBeVisible();
    await uploadFile(page, "empty.csv", "");
    await expect(page.getByTestId("ingest-error")).toContainText(/empty/i);
  });

  test("imports Parquet files fully offline", async ({ page }) => {
    const n = 5000;
    const t0 = Date.UTC(2021, 0, 1);
    const buffer = parquetWriteBuffer({
      columnData: [
        { name: "timestamp", data: Array.from({ length: n }, (_, i) => new Date(t0 + i * 3_600_000)), type: "TIMESTAMP" },
        { name: "ticker", data: Array.from({ length: n }, (_, i) => (i % 2 ? "AAA" : "BBB")), type: "STRING" },
        { name: "close", data: Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 50) * 5), type: "DOUBLE" },
        { name: "volume", data: Array.from({ length: n }, (_, i) => i), type: "DOUBLE" },
      ],
    });
    await openWorkbench(page);
    // Block every external host: Parquet support must not depend on extension downloads.
    await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
    await uploadFile(page, "hourly.parquet", Buffer.from(buffer), "application/octet-stream");
    await waitForDataset(page, "hourly");
    const [r] = await sql(page, "SELECT count(*) AS n, count(DISTINCT symbol) AS s, sum(volume) AS v FROM hourly");
    expect(r.n).toBe(n);
    expect(r.s).toBe(2);
    expect(r.v).toBe((n * (n - 1)) / 2);
    await expect(page.getByTestId("price-chart")).toBeVisible();
  });
});
