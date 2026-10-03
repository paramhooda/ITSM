import { AppError } from '@/core/errors';

/**
 * Provider-agnostic chat interface with tool calling. Implementations:
 * - AnthropicProvider (Claude via the official SDK)
 * - OpenAICompatibleProvider (any /v1/chat/completions endpoint: OpenAI, vLLM, Ollama, LM Studio, Azure OpenAI...)
 * - NullProvider (AI disabled)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  /** `raw` carries the provider's own content blocks of an earlier reply (thinking blocks included) so a tool-use turn can be replayed verbatim. */
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** `refusal`: the provider's safety layer declined; the text (if any) is the user-facing explanation. */
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** Provider-specific content blocks to replay on the next request of the same turn. */
  raw?: unknown;
}

/**
 * The system prompt is either one string or two blocks: `stable` never changes
 * between requests of the same role (identity, rules, style) and is cached by
 * providers that support prompt caching; `volatile` carries the per-turn context.
 */
export type SystemPrompt = string | { stable: string; volatile: string };

export const systemText = (s: SystemPrompt): string => (typeof s === 'string' ? s : `${s.stable}\n\n${s.volatile}`);

export interface ChatOptions {
  system: SystemPrompt;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Ignored by models that do not accept sampling parameters (Claude 4.7 and later). */
  temperature?: number;
  /** Reasoning effort for models that support it; ignored elsewhere. */
  effort?: 'low' | 'medium' | 'high';
  /** Aborts the request (turn deadline). */
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Endpoint the provider talks to (no credentials), shown on the admin screen. */
  readonly baseUrl?: string;
  chat(opts: ChatOptions): Promise<ChatResponse>;
}

/**
 * The upstream model API rejected or failed the request. Carries the upstream
 * HTTP status and an excerpt of its body so the admin screen and the assistant
 * panel can show the real reason (never the credentials).
 */
export class AiUpstreamError extends AppError {
  constructor(
    public provider: string,
    public upstreamStatus: number | null,
    public upstreamMessage: string,
    public model?: string,
  ) {
    super(502, upstreamStatus ? `The AI provider rejected the request (HTTP ${upstreamStatus}): ${upstreamMessage}` : `The AI provider could not be reached: ${upstreamMessage}`, 'ai_upstream', { provider, upstreamStatus, model });
    this.name = 'AiUpstreamError';
  }
}

/** Pulls the human-readable message out of an OpenAI / Anthropic style error body. */
export function upstreamMessage(body: string, max = 500): string {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string; code?: string } | string; message?: string };
    const err = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    if (err) return String(err).slice(0, max);
  } catch {
    /* not JSON */
  }
  return (text || 'empty response').replace(/\s+/g, ' ').slice(0, max);
}

export class NullProvider implements AiProvider {
  readonly name = 'none';
  readonly model = '';
  async chat(): Promise<ChatResponse> {
    throw new Error('AI provider is not configured (set AI_PROVIDER and credentials)');
  }
}
