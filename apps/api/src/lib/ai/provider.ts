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
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatOptions {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
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
