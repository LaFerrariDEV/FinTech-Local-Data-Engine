/** Provider-neutral conversation model used by the agent loop and UI. */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the provider returned arguments that were not valid JSON. */
  parseError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type ChatTurn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native content, replayed verbatim on the next request (e.g. Claude thinking blocks). */
      raw?: unknown;
      provider?: string;
    }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stopReason: StopReason;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  notice?: string;
}

export interface CompleteRequest {
  system: string;
  turns: ChatTurn[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  complete(request: CompleteRequest): Promise<LlmResponse>;
}

export type ProviderKind = "anthropic" | "openai-compatible";

export interface AgentSettings {
  presetId: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  rememberKey: boolean;
  /** Claude effort level (low..max). Empty = model default. */
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  maxSteps: number;
}

export class AgentError extends Error {
  readonly kind: "auth" | "rate_limit" | "network" | "bad_request" | "server" | "refusal" | "config" | "aborted" | "unknown";
  constructor(kind: AgentError["kind"], message: string) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
  }
}
