import Anthropic from "@anthropic-ai/sdk";
import { AgentError, type AgentSettings, type ChatTurn, type CompleteRequest, type LlmProvider, type LlmResponse, type ToolCall } from "./types";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: AgentSettings["kind"];
  baseUrl: string;
  defaultModel: string;
  modelPlaceholder: string;
  needsKey: boolean;
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-5-5",
    modelPlaceholder: "claude-opus-5-5",
    needsKey: true,
    note: "Calls the Claude API directly from your browser with your key.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    modelPlaceholder: "model id, e.g. from your OpenAI dashboard",
    needsKey: true,
    note: "OpenAI Chat Completions API with function calling.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "",
    modelPlaceholder: "a tool-capable local model, e.g. qwen2.5",
    needsKey: false,
    note: "Fully offline. Use a model with tool-calling support. Ollama allows localhost origins by default; set OLLAMA_ORIGINS for other hosts.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    modelPlaceholder: "loaded model id",
    needsKey: false,
    note: "Enable the local server and CORS in LM Studio.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "",
    modelPlaceholder: "provider/model",
    needsKey: true,
    note: "Any OpenRouter model that supports tools.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    defaultModel: "",
    modelPlaceholder: "model id",
    needsKey: false,
    note: "vLLM, llama.cpp server, Groq, Together, etc.",
  },
];

export function defaultSettings(): AgentSettings {
  const p = PROVIDER_PRESETS[0];
  return { presetId: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.defaultModel, apiKey: "", rememberKey: false, effort: "", maxSteps: 10 };
}

export function validateSettings(settings: AgentSettings): string | null {
  if (!settings.baseUrl.trim()) return "Base URL is required.";
  try {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL must be http(s).";
  } catch {
    return "Base URL is not a valid URL.";
  }
  if (!settings.model.trim()) return "Model is required.";
  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.presetId);
  if (preset?.needsKey && !settings.apiKey.trim()) return `${preset.label} requires an API key.`;
  if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1 || settings.maxSteps > 50) return "Max steps must be between 1 and 50.";
  return null;
}

export function createProvider(settings: AgentSettings, fetchImpl: typeof fetch = (...args) => fetch(...args)): LlmProvider {
  const problem = validateSettings(settings);
  if (problem) throw new AgentError("config", problem);
  return settings.kind === "anthropic" ? new AnthropicProvider(settings, fetchImpl) : new OpenAICompatibleProvider(settings, fetchImpl);
}

// ---------------------------------------------------------------- Anthropic (official SDK)

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(
    private readonly settings: AgentSettings,
    fetchImpl: typeof fetch,
  ) {
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl.replace(/\/$/, ""),
      // Local-first app: the key is supplied by the user and never leaves their browser except to the API.
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      fetch: fetchImpl,
    });
  }

  static toMessages(turns: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const turn of turns) {
      if (turn.role === "user") {
        messages.push({ role: "user", content: turn.text });
      } else if (turn.role === "assistant") {
        if (turn.provider === "anthropic" && Array.isArray(turn.raw)) {
          // Replay the exact content blocks (including thinking blocks) unchanged.
          messages.push({ role: "assistant", content: turn.raw as Anthropic.Beta.BetaContentBlockParam[] });
        } else {
          const content: Anthropic.Beta.BetaContentBlockParam[] = [];
          if (turn.text) content.push({ type: "text", text: turn.text });
          for (const call of turn.toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
          if (content.length) messages.push({ role: "assistant", content });
        }
      } else {
        // All results for one assistant turn go back in a single user message.
        messages.push({
          role: "user",
          content: turn.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.toolCallId, content: r.content, is_error: r.isError })),
        });
      }
    }
    return messages;
  }

  async complete({ system, turns, tools, signal }: CompleteRequest): Promise<LlmResponse> {
    const model = this.settings.model.trim();
    const useFallback = FALLBACK_MODELS.test(model) && /api\.anthropic\.com/.test(this.settings.baseUrl);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 16000,
      system,
      messages: AnthropicProvider.toMessages(turns),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
      tool_choice: { type: "auto" },
      ...(this.settings.effort ? { output_config: { effort: this.settings.effort } } : {}),
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming;
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(params, { signal });
    } catch (error) {
      throw mapAnthropicError(error, signal);
    }
    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") text.push(block.text);
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
    let stopReason: LlmResponse["stopReason"] = "other";
    let notice: string | undefined;
    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        stopReason = "end";
        break;
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        notice = "The response hit the output token limit and may be incomplete.";
        break;
      case "refusal": {
        stopReason = "refusal";
        const details = (response as unknown as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
        notice = `The model declined this request${details?.category ? ` (${details.category})` : ""}.${details?.explanation ? ` ${details.explanation}` : ""}`;
        break;
      }
      default:
        stopReason = toolCalls.length ? "tool_use" : "end";
    }
    return {
      text: text.join("\n").trim(),
      toolCalls,
      raw: response.content,
      stopReason,
      model: response.model,
      usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens },
      notice,
    };
  }
}

function mapAnthropicError(error: unknown, signal?: AbortSignal): AgentError {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return new AgentError("aborted", "Request cancelled");
  if (error instanceof Anthropic.AuthenticationError) return new AgentError("auth", "Invalid Anthropic API key.");
  if (error instanceof Anthropic.PermissionDeniedError) return new AgentError("auth", `Permission denied: ${error.message}`);
  if (error instanceof Anthropic.NotFoundError) return new AgentError("bad_request", `Not found (check the model id): ${error.message}`);
  if (error instanceof Anthropic.RateLimitError) return new AgentError("rate_limit", "Rate limited by the Anthropic API — retry shortly.");
  if (error instanceof Anthropic.BadRequestError) return new AgentError("bad_request", error.message);
  if (error instanceof Anthropic.InternalServerError) return new AgentError("server", `Anthropic API error: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new AgentError("network", `Could not reach the Anthropic API: ${error.message}`);
  if (error instanceof Anthropic.APIError) return new AgentError("server", `API error ${error.status ?? ""}: ${error.message}`);
  return new AgentError("unknown", error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- OpenAI-compatible (fetch)

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  constructor(
    private readonly settings: AgentSettings,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static toMessages(system: string, turns: ChatTurn[]): OaiMessage[] {
    const messages: OaiMessage[] = [{ role: "system", content: system }];
    for (const turn of turns) {
      if (turn.role === "user") messages.push({ role: "user", content: turn.text });
      else if (turn.role === "assistant") {
        messages.push({
          role: "assistant",
          content: turn.text || null,
          ...(turn.toolCalls.length
            ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
            : {}),
        });
      } else {
        for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }
    }
    return messages;
  }

  async complete({ system, turns, tools, signal }: CompleteRequest): Promise<LlmResponse> {
    const url = `${this.settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.apiKey.trim()) headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;
    const body = {
      model: this.settings.model.trim(),
      messages: OpenAICompatibleProvider.toMessages(system, turns),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: "auto",
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw new AgentError("aborted", "Request cancelled");
      throw new AgentError(
        "network",
        `Could not reach ${url}. If this is a local server, make sure it is running and allows requests from this origin (CORS). ${error instanceof Error ? error.message : ""}`.trim(),
      );
    }
    const textBody = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = textBody ? (JSON.parse(textBody) as Record<string, unknown>) : {};
    } catch {
      if (!res.ok) throw new AgentError(res.status >= 500 ? "server" : "bad_request", `HTTP ${res.status}: ${textBody.slice(0, 300)}`);
      throw new AgentError("server", "The provider returned a non-JSON response.");
    }
    if (!res.ok) {
      const err = json.error as { message?: string } | string | undefined;
      const message = typeof err === "string" ? err : (err?.message ?? textBody.slice(0, 300));
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : "bad_request";
      throw new AgentError(kind, `HTTP ${res.status}: ${message}`);
    }
    const choice = (json.choices as { message?: OaiMessage & { reasoning_content?: string }; finish_reason?: string }[] | undefined)?.[0];
    if (!choice?.message) throw new AgentError("server", "The provider returned no choices.");
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c, i) => {
      let input: Record<string, unknown> = {};
      let parseError: string | undefined;
      try {
        const parsed = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        parseError = `Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, input, parseError };
    });
    const finish = choice.finish_reason;
    const stopReason: LlmResponse["stopReason"] =
      toolCalls.length > 0 ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end";
    const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return {
      text: (choice.message.content ?? "").trim(),
      toolCalls,
      raw: choice.message,
      stopReason,
      model: String(json.model ?? this.settings.model),
      usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens },
      notice: stopReason === "max_tokens" ? "The response hit the output token limit and may be incomplete." : stopReason === "refusal" ? "The provider filtered this response." : undefined,
    };
  }
}
