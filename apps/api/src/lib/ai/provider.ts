/**
 * Provider-agnostic chat interface with tool calling. Implementations:
 * - AnthropicProvider (Claude via the official SDK)
 * - OpenAICompatibleProvider (any /v1/chat/completions endpoint: vLLM, Ollama, LM Studio, Azure OpenAI...)
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
  chat(opts: ChatOptions): Promise<ChatResponse>;
}

export class NullProvider implements AiProvider {
  readonly name = 'none';
  readonly model = '';
  async chat(): Promise<ChatResponse> {
    throw new Error('AI provider is not configured (set AI_PROVIDER and credentials)');
  }
}
