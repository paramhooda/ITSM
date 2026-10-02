import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/core/logger';
import { AiUpstreamError, type AiProvider, type ChatOptions, type ChatResponse, type ToolCall } from './provider';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly baseUrl = 'https://api.anthropic.com';
  private client: Anthropic;
  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const messages: Anthropic.MessageParam[] = [];
    for (const m of opts.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const t of m.toolCalls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
        if (content.length) messages.push({ role: 'assistant', content });
      } else {
        const last = messages[messages.length - 1];
        const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: m.isError };
        if (last && last.role === 'user' && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages,
        tools: opts.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool['input_schema'] })),
      });
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status ?? null : null;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      logger.warn({ provider: this.name, model: this.model, upstreamStatus: status, upstreamMessage: message }, 'AI endpoint error');
      throw new AiUpstreamError(this.name, status, message, this.model);
    }
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason === 'end_turn' ? 'end' : 'other',
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}
