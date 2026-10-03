import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/core/logger';
import { AiUpstreamError, type AiProvider, type ChatOptions, type ChatResponse, type ToolCall } from './provider';

/** Client-side limits: the SDK retries 408/409/429/5xx and connection errors itself. */
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

/**
 * What a Claude model accepts. Claude 4.7 and later (and every Claude 5) reject
 * sampling parameters (`temperature`, `top_p`, `top_k`) with a 400 and run with
 * thinking on, controlled by `output_config.effort`; 4.6 accepts both; Haiku and
 * older models accept sampling only.
 */
export function modelProfile(model: string): { sampling: boolean; effort: boolean } {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return { sampling: true, effort: false }; // claude-3-5-sonnet-20241022 style ids
  const family = m[1]!.toLowerCase();
  const major = Number(m[2]);
  const rawMinor = m[3] ? Number(m[3]) : 0;
  const minor = rawMinor > 99 ? 0 : rawMinor; // a date suffix is not a minor version
  if (family === 'haiku') return { sampling: true, effort: false };
  if (major >= 5 || (major === 4 && minor >= 7)) return { sampling: false, effort: true };
  if (major === 4 && minor === 6) return { sampling: true, effort: true };
  return { sampling: true, effort: false };
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly baseUrl = 'https://api.anthropic.com';
  private client: Anthropic;
  private profile: { sampling: boolean; effort: boolean };
  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    this.profile = modelProfile(model);
  }

  /** The request body for one chat call (exposed for tests). */
  buildParams(opts: ChatOptions): Anthropic.MessageCreateParamsNonStreaming {
    const messages: Anthropic.MessageParam[] = [];
    for (const m of opts.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        // Replay the provider's own blocks when we have them: thinking blocks must accompany the tool_use they led to.
        if (Array.isArray(m.raw) && m.raw.length) {
          messages.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] });
          continue;
        }
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
    // Prompt caching is a prefix match over tools → system → messages: the stable system block and the last tool carry the breakpoints.
    const system: Anthropic.TextBlockParam[] =
      typeof opts.system === 'string'
        ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
        : [
            { type: 'text', text: opts.system.stable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: opts.system.volatile },
          ];
    const tools = opts.tools?.map((t, i, all) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(this.profile.sampling && opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(this.profile.effort && opts.effort ? { output_config: { effort: opts.effort } } : {}),
    };
    return params;
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(this.buildParams(opts), { signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // the caller's deadline: not an upstream failure
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
    const usage = res.usage as Anthropic.Usage & { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason === 'end_turn' ? 'end' : res.stop_reason === 'refusal' ? 'refusal' : 'other',
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0 },
      raw: res.content,
    };
  }
}
