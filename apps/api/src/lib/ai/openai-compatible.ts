import { logger } from '@/core/logger';
import { AiUpstreamError, upstreamMessage, type AiProvider, type ChatOptions, type ChatResponse, type ToolCall } from './provider';

/** Models that only accept `max_completion_tokens` and the default temperature (OpenAI reasoning / gpt-5 families). */
const COMPLETION_TOKENS_MODELS = /^(gpt-5|o\d)/i;
const UNSUPPORTED_PARAM = /max_tokens|max_completion_tokens|temperature/i;

/**
 * Normalises what operators put in OPENAI_COMPATIBLE_BASE_URL:
 * trims, drops a pasted `/chat/completions`, and adds `/v1` for api.openai.com when missing.
 */
export function normaliseBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  try {
    const u = new URL(url);
    if (u.hostname === 'api.openai.com' && !/\/v\d+$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1`;
    url = u.toString().replace(/\/+$/, '');
  } catch {
    /* keep as typed; the request will fail with a clear error */
  }
  return url;
}

/** Minimal client for OpenAI-compatible chat completion endpoints (OpenAI, vLLM, Ollama, LM Studio, Azure OpenAI...). */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai_compatible';
  readonly baseUrl: string;
  constructor(baseUrl: string, private apiKey: string | undefined, readonly model: string) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
  }

  private buildBody(opts: ChatOptions, completionTokens: boolean) {
    const messages: Record<string, unknown>[] = [{ role: 'system', content: opts.system }];
    for (const m of opts.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const toolCalls = m.toolCalls?.length ? m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) : undefined;
        // `content: null` is only accepted alongside tool calls.
        messages.push({ role: 'assistant', content: m.content || (toolCalls ? null : ''), ...(toolCalls ? { tool_calls: toolCalls } : {}) });
      } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    const limit = opts.maxTokens ?? 2048;
    return {
      model: this.model,
      messages,
      ...(completionTokens ? { max_completion_tokens: limit } : { max_tokens: limit, temperature: opts.temperature ?? 0.2 }),
      tools: opts.tools?.length ? opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
    };
  }

  private async post(body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out after 120s' : err.message) : String(err);
      logger.warn({ provider: this.name, model: this.model, baseUrl: this.baseUrl, err: message }, 'AI endpoint unreachable');
      throw new AiUpstreamError(this.name, null, message, this.model);
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    let completionTokens = COMPLETION_TOKENS_MODELS.test(this.model);
    let res = await this.post(this.buildBody(opts, completionTokens));
    if (res.status === 400 && !completionTokens) {
      // Newer models and some proxies reject max_tokens / temperature: retry once in the modern shape.
      const text = await res.text();
      if (UNSUPPORTED_PARAM.test(text)) {
        logger.info({ provider: this.name, model: this.model }, 'AI endpoint rejected max_tokens/temperature; retrying with max_completion_tokens');
        completionTokens = true;
        res = await this.post(this.buildBody(opts, true));
      } else {
        throw this.fail(res.status, text);
      }
    }
    if (!res.ok) throw this.fail(res.status, await res.text());
    const data = (await res.json()) as { choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const choice = data.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((t) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(t.function.arguments || '{}');
      } catch {
        input = {};
      }
      return { id: t.id, name: t.function.name, input };
    });
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      stopReason: toolCalls.length ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  private fail(status: number, body: string) {
    const message = upstreamMessage(body);
    logger.warn({ provider: this.name, model: this.model, baseUrl: this.baseUrl, upstreamStatus: status, upstreamMessage: message }, 'AI endpoint error');
    return new AiUpstreamError(this.name, status, message, this.model);
  }
}
