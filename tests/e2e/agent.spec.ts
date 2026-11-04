import { expect, test, type Page } from "@playwright/test";
import { openWorkbench } from "./helpers";

async function configureProvider(page: Page, provider: "Custom (OpenAI-compatible)" | "Anthropic (Claude)", baseUrl: string, model: string, key = "") {
  await page.getByTestId("agent-settings").click();
  await page.getByTestId("provider-select").click();
  await page.getByRole("option", { name: provider }).click();
  await page.getByLabel("Base URL").fill(baseUrl);
  await page.getByTestId("agent-model").fill(model);
  if (key) await page.getByTestId("agent-key").fill(key);
  await page.getByTestId("agent-save").click();
}

test.describe("AI agent (mocked providers)", () => {
  test("OpenAI-compatible provider: runs local SQL via tools and answers", async ({ page }) => {
    const requests: { messages: { role: string; content: string | null; tool_call_id?: string }[] }[] = [];
    await page.route("http://mock-llm.test/v1/chat/completions", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
      if (!toolMsg) {
        return route.fulfill({
          json: {
            model: "mock-1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "run_sql", arguments: JSON.stringify({ sql: "SELECT symbol, count(*) AS n FROM sample_equities_daily GROUP BY 1 ORDER BY 1" }) } },
                    { id: "call_2", type: "function", function: { name: "show_chart", arguments: JSON.stringify({ dataset: "sample_equities_daily", symbol: "GLOBX", timeframe: "1w", indicators: [{ type: "sma", period: 10 }] }) } },
                  ],
                },
              },
            ],
          },
        });
      }
      const rows = JSON.parse(toolMsg.content).rows as { symbol: string; n: number }[];
      return route.fulfill({
        json: { model: "mock-1", choices: [{ finish_reason: "stop", message: { role: "assistant", content: `Found ${rows.length} symbols: ${rows.map((r) => `${r.symbol}=${r.n}`).join(", ")}.` } }] },
      });
    });

    await openWorkbench(page);
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    await configureProvider(page, "Custom (OpenAI-compatible)", "http://mock-llm.test/v1", "mock-1");
    await page.getByTestId("agent-input").fill("How many bars per symbol?");
    await page.getByTestId("agent-send").click();
    await expect(page.getByTestId("agent-message")).toContainText("Found 3 symbols: ACME=2520, GLOBX=2520, INITECH=2520.");
    await expect(page.getByTestId("agent-tool")).toHaveCount(2);
    // The agent drove the chart.
    await expect(page.getByTestId("tf-1w")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("chart-legend")).toContainText("GLOBX");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.filter((m) => m.role === "tool")).toHaveLength(2);
    // The system prompt describes the local datasets.
    expect(requests[0].messages[0].content).toContain("sample_equities_daily");
  });

  test("Anthropic provider: tool loop through the official SDK, write attempts are blocked", async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("https://api.anthropic.com/v1/messages*", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      const body = route.request().postDataJSON();
      bodies.push(body);
      const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
      const last = body.messages[body.messages.length - 1];
      const toolResult = Array.isArray(last.content) ? last.content.find((b: { type: string }) => b.type === "tool_result") : null;
      if (!toolResult) {
        return route.fulfill({
          headers,
          json: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [
              { type: "thinking", thinking: "", signature: "sig-abc" },
              { type: "tool_use", id: "toolu_1", name: "run_sql", input: { sql: "DROP TABLE sample_equities_daily" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        });
      }
      return route.fulfill({
        headers,
        json: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: toolResult.is_error ? "That write was blocked: the database is read-only for me." : "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      });
    });

    await openWorkbench(page);
    await page.getByTestId("sample-daily").click();
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    await configureProvider(page, "Anthropic (Claude)", "https://api.anthropic.com", "claude-opus-5-5", "sk-ant-test");
    await page.getByTestId("agent-input").fill("Delete the dataset");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("agent-message")).toContainText("blocked");
    await expect(page.getByTestId("agent-tool")).toContainText("error");
    await expect(page.getByTestId("dataset-sample_equities_daily")).toBeVisible();
    expect(bodies).toHaveLength(2);
    // Thinking blocks are replayed unchanged and tool results are sent back with is_error.
    const second = bodies[1] as { messages: { role: string; content: { type: string; signature?: string; is_error?: boolean }[] }[]; tool_choice: unknown };
    expect(second.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(second.tool_choice).toEqual({ type: "auto" });
  });

  test("shows provider failures without breaking the panel", async ({ page }) => {
    await page.route("http://mock-llm.test/v1/chat/completions", (route) => route.fulfill({ status: 500, json: { error: { message: "model overloaded" } } }));
    await openWorkbench(page);
    await configureProvider(page, "Custom (OpenAI-compatible)", "http://mock-llm.test/v1", "mock-1");
    await page.getByTestId("agent-input").fill("hello");
    await page.getByTestId("agent-send").click();
    await expect(page.getByTestId("agent-panel")).toContainText("model overloaded");
    await expect(page.getByTestId("agent-input")).toBeEnabled();
  });
});
