import type { AiProvider, ChatOptions, ChatResponse, ToolCall } from './provider';

/** Minimal client for OpenAI-compatible chat completion endpoints (vLLM, Ollama, LM Studio, Azure OpenAI...). */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai_compatible';
  constructor(private baseUrl: string, private apiKey: string | undefined, readonly model: string) {}

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const messages: Record<string, unknown>[] = [{ role: 'system', content: opts.system }];
    for (const m of opts.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls?.length ? m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) : undefined,
        });
      } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
      tools: opts.tools?.length ? opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
    };
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`AI endpoint error ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
}
