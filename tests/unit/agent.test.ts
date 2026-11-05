import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, runAgent } from "../../src/lib/agent/agent";
import { AnthropicProvider, createProvider, OpenAICompatibleProvider, validateSettings, defaultSettings } from "../../src/lib/agent/providers";
import { executeTool, parseIndicators, parseStrategy } from "../../src/lib/agent/tools";
import type { ChatTurn, LlmProvider, LlmResponse } from "../../src/lib/agent/types";
import type { EngineClient } from "../../src/lib/engine/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fakeClient = (handler: (method: string, params: unknown) => unknown) =>
  ({ call: vi.fn(async (method: string, params: unknown) => handler(method, params)) }) as unknown as EngineClient;

const ui = { showChart: vi.fn(), showBacktest: vi.fn() };

describe("settings", () => {
  it("validates provider settings", () => {
    const s = defaultSettings();
    expect(s.model).toBe("claude-opus-5-5");
    expect(validateSettings(s)).toMatch(/API key/);
    expect(validateSettings({ ...s, apiKey: "k" })).toBeNull();
    expect(validateSettings({ ...s, apiKey: "k", baseUrl: "ftp://x" })).toMatch(/http/);
    expect(validateSettings({ ...s, presetId: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "" })).toMatch(/Model/);
    expect(validateSettings({ ...s, presetId: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" })).toBeNull();
    expect(() => createProvider({ ...s, apiKey: "" })).toThrow(/API key/);
  });
});

describe("OpenAI-compatible provider", () => {
  const settings = { ...defaultSettings(), presetId: "custom", kind: "openai-compatible" as const, baseUrl: "http://llm.local/v1/", model: "m", apiKey: "secret" };

  it("serializes tool turns and parses tool calls", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        model: "m",
        choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run_sql", arguments: '{"sql":"SELECT 1"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const provider = new OpenAICompatibleProvider(settings, fetchMock as unknown as typeof fetch);
    const turns: ChatTurn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "c0", name: "list_datasets", input: {} }] },
      { role: "tool", results: [{ toolCallId: "c0", name: "list_datasets", content: "[]", isError: false }] },
    ];
    const res = await provider.complete({ system: "sys", turns, tools: [{ name: "run_sql", description: "d", inputSchema: { type: "object" } }] });
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "run_sql", input: { sql: "SELECT 1" }, parseError: undefined }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://llm.local/v1/chat/completions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(String(init!.body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c0", content: "[]" });
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "run_sql" } });
  });

  it("flags invalid JSON arguments instead of throwing", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_sql", arguments: "{bad" } }] } }] }),
    );
    const res = await new OpenAICompatibleProvider(settings, fetchMock as unknown as typeof fetch).complete({ system: "", turns: [], tools: [] });
    expect(res.toolCalls[0].parseError).toMatch(/Invalid JSON/);
  });

  it("maps HTTP and network failures to typed agent errors", async () => {
    const auth = new OpenAICompatibleProvider(settings, (async () => jsonResponse({ error: { message: "bad key" } }, 401)) as unknown as typeof fetch);
    await expect(auth.complete({ system: "", turns: [], tools: [] })).rejects.toMatchObject({ kind: "auth" });
    const rate = new OpenAICompatibleProvider(settings, (async () => jsonResponse({ error: "slow down" }, 429)) as unknown as typeof fetch);
    await expect(rate.complete({ system: "", turns: [], tools: [] })).rejects.toMatchObject({ kind: "rate_limit" });
    const down = new OpenAICompatibleProvider(settings, (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(down.complete({ system: "", turns: [], tools: [] })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("Anthropic provider", () => {
  it("replays raw Claude content blocks verbatim and groups tool results", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "run_sql", input: { sql: "SELECT 1" } },
    ];
    const msgs = AnthropicProvider.toMessages([
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "run_sql", input: {} }], raw, provider: "anthropic" },
      {
        role: "tool",
        results: [
          { toolCallId: "t1", name: "run_sql", content: "{}", isError: false },
          { toolCallId: "t2", name: "x", content: "err", isError: true },
        ],
      },
    ]);
    expect(msgs[1]).toEqual({ role: "assistant", content: raw });
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toHaveLength(2);
    expect((msgs[2].content as { type: string; is_error: boolean }[])[1]).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
  });

  it("calls the Messages API with tools, auto tool choice and the refusal fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const provider = createProvider({ ...defaultSettings(), apiKey: "sk-test" }, fetchMock as unknown as typeof fetch);
    const res = await provider.complete({ system: "sys", turns: [{ role: "user", text: "hi" }], tools: [{ name: "list_datasets", description: "d", inputSchema: { type: "object", properties: {} } }] });
    expect(res).toMatchObject({ text: "Hello", stopReason: "end", model: "claude-opus-5-5" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init!.headers);
    // SDK 1.x (API version 2026-10-21) sends the key as a bearer token.
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: "claude-opus-5-5", system: "sys", tool_choice: { type: "auto" }, fallbacks: "default" });
    expect(body.temperature).toBeUndefined();
    expect(body.tools[0]).toMatchObject({ name: "list_datasets", input_schema: { type: "object" } });
  });

  it("surfaces refusals with their category", async () => {
    const fetchMock = async () =>
      jsonResponse({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    const provider = createProvider({ ...defaultSettings(), apiKey: "k" }, fetchMock as unknown as typeof fetch);
    const res = await provider.complete({ system: "", turns: [{ role: "user", text: "x" }], tools: [] });
    expect(res.stopReason).toBe("refusal");
    expect(res.notice).toMatch(/cyber/);
  });

  it("maps authentication errors", async () => {
    const fetchMock = async () => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
    const provider = createProvider({ ...defaultSettings(), apiKey: "bad" }, fetchMock as unknown as typeof fetch);
    await expect(provider.complete({ system: "", turns: [{ role: "user", text: "x" }], tools: [] })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("agent loop", () => {
  const scripted = (responses: Partial<LlmResponse>[]): LlmProvider => {
    let i = 0;
    return {
      id: "test",
      complete: vi.fn(async () => ({ text: "", toolCalls: [], raw: null, stopReason: "end", model: "m", ...responses[i++] }) as LlmResponse),
    };
  };

  it("executes tools against the engine and feeds results back", async () => {
    const provider = scripted([
      { stopReason: "tool_use", toolCalls: [{ id: "a", name: "run_sql", input: { sql: "SELECT 42 AS x" } }] },
      { text: "The answer is 42." },
    ]);
    const client = fakeClient((method) => (method === "agentQuery" ? { columns: ["x"], rows: [{ x: 42 }], truncated: false, elapsedMs: 1 } : null));
    const events: string[] = [];
    const out = await runAgent({
      provider,
      providerId: "test",
      system: "s",
      history: [{ role: "user", text: "q" }],
      maxSteps: 5,
      toolContext: { client, ui },
      onEvent: (e) => events.push(e.type),
    });
    expect(out.error).toBeNull();
    expect(out.history.map((t) => t.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = out.history[2] as Extract<ChatTurn, { role: "tool" }>;
    expect(JSON.parse(tool.results[0].content).rows).toEqual([{ x: 42 }]);
    expect(events).toEqual(["assistant", "tool_start", "tool_end", "assistant"]);
  });

  it("stops at the step limit with a well-formed history", async () => {
    const provider = scripted(Array.from({ length: 5 }, (_, i) => ({ stopReason: "tool_use" as const, toolCalls: [{ id: `c${i}`, name: "list_datasets", input: {} }] })));
    const out = await runAgent({
      provider,
      providerId: "test",
      system: "s",
      history: [{ role: "user", text: "q" }],
      maxSteps: 2,
      toolContext: { client: fakeClient(() => []), ui },
      onEvent: () => undefined,
    });
    expect(out.history.filter((t) => t.role === "assistant")).toHaveLength(2);
    expect(out.history[out.history.length - 1].role).toBe("tool");
  });

  it("repairs history when cancelled mid-run", async () => {
    const controller = new AbortController();
    const provider: LlmProvider = {
      id: "test",
      complete: async () => {
        controller.abort();
        return { text: "", toolCalls: [{ id: "z", name: "list_datasets", input: {} }], raw: null, stopReason: "tool_use", model: "m" };
      },
    };
    const out = await runAgent({
      provider,
      providerId: "test",
      system: "s",
      history: [{ role: "user", text: "q" }],
      maxSteps: 3,
      toolContext: { client: fakeClient(() => []), ui },
      signal: controller.signal,
      onEvent: () => undefined,
    });
    expect(out.error?.kind).toBe("aborted");
    const last = out.history[out.history.length - 1] as Extract<ChatTurn, { role: "tool" }>;
    expect(last.role).toBe("tool");
    expect(last.results[0]).toMatchObject({ toolCallId: "z", isError: true, content: "Cancelled by the user" });
  });

  it("returns provider errors without throwing", async () => {
    const provider: LlmProvider = {
      id: "test",
      complete: async () => {
        throw new Error("socket hang up");
      },
    };
    const out = await runAgent({ provider, providerId: "t", system: "", history: [{ role: "user", text: "q" }], maxSteps: 1, toolContext: { client: fakeClient(() => null), ui }, onEvent: () => undefined });
    expect(out.error?.message).toMatch(/socket hang up/);
  });
});

describe("tools", () => {
  it("parses indicator and strategy specs with defaults", () => {
    expect(parseIndicators([{ type: "sma", period: 50 }, { type: "macd" }, { type: "bbands" }])).toEqual([
      { type: "sma", period: 50 },
      { type: "macd", fast: 12, slow: 26, signal: 9 },
      { type: "bbands", period: 20, mult: 2 },
    ]);
    expect(() => parseIndicators([{ type: "nope" }])).toThrow(/Unknown indicator/);
    expect(parseStrategy({ type: "sma_cross", fast: "10", slow: 30 })).toEqual({ type: "sma_cross", fast: 10, slow: 30 });
  });

  it("returns tool errors as results instead of throwing", async () => {
    const client = fakeClient(() => {
      throw new Error("Rejected SQL: Keyword DROP is not allowed in read-only mode");
    });
    const r = await executeTool({ id: "1", name: "run_sql", input: { sql: "DROP TABLE x" } }, { client, ui });
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/DROP/) });
    const unknown = await executeTool({ id: "2", name: "rm_rf", input: {} }, { client, ui });
    expect(unknown.isError).toBe(true);
  });

  it("show_chart drives the UI bridge", async () => {
    const client = fakeClient((method) => (method === "datasets" ? [{ name: "spy", symbols: ["SPY"] }] : null));
    const r = await executeTool({ id: "1", name: "show_chart", input: { dataset: "spy", timeframe: "1w", indicators: [{ type: "rsi" }] } }, { client, ui });
    expect(r.isError).toBe(false);
    expect(ui.showChart).toHaveBeenCalledWith({ dataset: "spy", symbol: null, timeframe: "1w", indicators: [{ type: "rsi", period: 14 }] });
  });

  it("system prompt lists datasets", () => {
    const p = buildSystemPrompt([], "v1.5.4");
    expect(p).toContain("DuckDB v1.5.4");
    expect(p).toContain("no datasets loaded");
  });
});
