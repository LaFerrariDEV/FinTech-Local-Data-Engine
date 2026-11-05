import type { DatasetInfo } from "../quant/types";
import { AGENT_TOOLS, executeTool, summarizeDataset, type ToolContext } from "./tools";
import { AgentError, type ChatTurn, type LlmProvider, type LlmResponse, type ToolResult } from "./types";

export function buildSystemPrompt(datasets: DatasetInfo[], duckdbVersion: string): string {
  const catalog = datasets.length
    ? datasets.map((d) => JSON.stringify(summarizeDataset(d))).join("\n")
    : "(no datasets loaded yet — suggest the user drops a CSV/Parquet file or loads a sample dataset)";
  return `You are QuantAgent, a quantitative research assistant embedded in a local-first trading workbench.

Environment:
- All data lives in an in-browser DuckDB ${duckdbVersion} database (DuckDB SQL dialect). Nothing is uploaded anywhere.
- Each dataset has a normalized OHLCV table named after the dataset with columns (symbol VARCHAR, ts TIMESTAMP, open, high, low, close, volume DOUBLE), sorted by symbol, ts. The untouched source rows live in <name>_raw.
- Useful DuckDB features: time_bucket(INTERVAL '1 week', ts), date_trunc, window functions (lag, avg(...) OVER (PARTITION BY symbol ORDER BY ts ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)), QUALIFY, arg_max/arg_min, quantile_cont, corr, regr_slope, SUMMARIZE <table>.
- SQL through run_sql is read-only, one statement per call.

How to work:
- Ground every number in a tool result. Never invent prices, returns or statistics.
- Prefer one well-formed SQL query over many small ones; aggregate in SQL rather than pulling raw rows.
- Backtests are look-ahead free: positions decided at a bar's close are held over the next bar. Mention fees/slippage assumptions when reporting results, and compare against buy & hold.
- Use show_chart when a visual would help the user; it updates their chart directly.
- Be concise. Use short paragraphs or compact tables. Format percentages with 2 decimals.

Datasets currently loaded:
${catalog}`;
}

export type AgentEvent =
  | { type: "assistant"; turn: Extract<ChatTurn, { role: "assistant" }>; response: LlmResponse }
  | { type: "tool_start"; callId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; result: ToolResult; durationMs: number }
  | { type: "notice"; message: string };

export interface RunAgentOptions {
  provider: LlmProvider;
  providerId: string;
  system: string;
  history: ChatTurn[];
  maxSteps: number;
  toolContext: ToolContext;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

/** Ensures every tool call in the last assistant turn has a matching result (required by all providers). */
function repairHistory(history: ChatTurn[], reason: string): ChatTurn[] {
  const last = history[history.length - 1];
  if (last?.role === "assistant" && last.toolCalls.length > 0) {
    history.push({ role: "tool", results: last.toolCalls.map((c) => ({ toolCallId: c.id, name: c.name, content: reason, isError: true })) });
  }
  return history;
}

export interface AgentRunOutcome {
  history: ChatTurn[];
  error: AgentError | null;
}

/**
 * Agentic tool loop: call the model, execute requested tools against the local engine, feed
 * results back, repeat until the model answers or the step budget is exhausted. The returned
 * history is append-only (earlier turns are never edited) and always well-formed, even when
 * the run is cancelled or fails part-way.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunOutcome> {
  const history = [...options.history];
  try {
    for (let step = 0; step < options.maxSteps; step++) {
      if (options.signal?.aborted) throw new AgentError("aborted", "Request cancelled");
      const response = await options.provider.complete({ system: options.system, turns: history, tools: AGENT_TOOLS, signal: options.signal });
      const turn: Extract<ChatTurn, { role: "assistant" }> = {
        role: "assistant",
        text: response.text,
        toolCalls: response.toolCalls,
        raw: response.raw,
        provider: options.providerId,
      };
      history.push(turn);
      options.onEvent({ type: "assistant", turn, response });
      if (response.notice) options.onEvent({ type: "notice", message: response.notice });
      if (response.stopReason === "refusal" || response.toolCalls.length === 0) return { history, error: null };

      const results: ToolResult[] = [];
      for (const call of response.toolCalls) {
        if (options.signal?.aborted) throw new AgentError("aborted", "Request cancelled");
        options.onEvent({ type: "tool_start", callId: call.id, name: call.name, input: call.input });
        const started = performance.now();
        const result = await executeTool(call, { ...options.toolContext, signal: options.signal });
        results.push(result);
        options.onEvent({ type: "tool_end", result, durationMs: Math.round(performance.now() - started) });
      }
      history.push({ role: "tool", results });
    }
    options.onEvent({ type: "notice", message: `Stopped after ${options.maxSteps} steps (step limit). Ask the agent to continue if needed.` });
    return { history, error: null };
  } catch (error) {
    const agentError =
      error instanceof AgentError
        ? error
        : options.signal?.aborted
          ? new AgentError("aborted", "Request cancelled")
          : new AgentError("unknown", error instanceof Error ? error.message : String(error));
    return { history: repairHistory(history, agentError.kind === "aborted" ? "Cancelled by the user" : `Not executed: ${agentError.message}`), error: agentError };
  }
}
