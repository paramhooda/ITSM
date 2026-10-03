/**
 * Unit tests for the OpenAI-compatible provider: base URL normalisation, the
 * max_completion_tokens retry, message shaping and typed upstream errors.
 * No database: fetch is stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleProvider, normaliseBaseUrl } from '../src/lib/ai/openai-compatible';
import { AiUpstreamError, upstreamMessage } from '../src/lib/ai/provider';
import { AnthropicProvider, modelProfile } from '../src/lib/ai/anthropic';

const okBody = (content = 'OK') => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
const json = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (body: Record<string, unknown>, call: number) => Response) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    return handler(body, calls.length);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('normaliseBaseUrl', () => {
  it('adds /v1 for api.openai.com and strips pasted paths and slashes', () => {
    expect(normaliseBaseUrl('https://api.openai.com')).toBe('https://api.openai.com/v1');
    expect(normaliseBaseUrl('https://api.openai.com/')).toBe('https://api.openai.com/v1');
    expect(normaliseBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normaliseBaseUrl(' https://api.openai.com/v1/chat/completions ')).toBe('https://api.openai.com/v1');
  });
  it('leaves other endpoints alone apart from trailing slashes', () => {
    expect(normaliseBaseUrl('http://ollama:11434/v1/')).toBe('http://ollama:11434/v1');
    expect(normaliseBaseUrl('https://myproxy.example/openai/deployments/gpt4/chat/completions')).toBe('https://myproxy.example/openai/deployments/gpt4');
    expect(normaliseBaseUrl('not a url')).toBe('not a url');
  });
});

describe('upstreamMessage', () => {
  it('extracts OpenAI and Anthropic style error bodies', () => {
    expect(upstreamMessage(JSON.stringify({ error: { message: 'Unsupported parameter: max_tokens', type: 'invalid_request_error' } }))).toBe('Unsupported parameter: max_tokens');
    expect(upstreamMessage(JSON.stringify({ error: 'model_not_found' }))).toBe('model_not_found');
    expect(upstreamMessage('<html>Bad gateway</html>')).toBe('<html>Bad gateway</html>');
    expect(upstreamMessage('')).toBe('empty response');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('posts to <base>/chat/completions with the bearer key and classic parameters', async () => {
    const calls = stubFetch(() => json(200, okBody('pong')));
    const p = new OpenAICompatibleProvider('https://api.openai.com', 'sk-test', 'gpt-4o-mini');
    const res = await p.chat({ system: 'sys', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16, temperature: 0.1 });
    expect(res.text).toBe('pong');
    expect(res.stopReason).toBe('end');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 16, temperature: 0.1 });
    expect(calls[0]!.body).not.toHaveProperty('max_completion_tokens');
  });

  it('uses max_completion_tokens without temperature for reasoning / gpt-5 models', async () => {
    const calls = stubFetch(() => json(200, okBody()));
    const p = new OpenAICompatibleProvider('https://api.openai.com/v1', 'sk', 'gpt-5-mini');
    await p.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 50 });
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
    expect(calls[0]!.body).not.toHaveProperty('temperature');
  });

  it('retries once with max_completion_tokens when the endpoint rejects max_tokens', async () => {
    const calls = stubFetch((body, call) => (call === 1 && 'max_tokens' in body ? json(400, JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } })) : json(200, okBody('after retry'))));
    const p = new OpenAICompatibleProvider('https://api.openai.com/v1', 'sk', 'gpt-future');
    const res = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('after retry');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ max_completion_tokens: 2048 });
    expect(calls[1]!.body).not.toHaveProperty('temperature');
  });

  it('surfaces other 400s as AiUpstreamError with the upstream message, without retrying', async () => {
    const calls = stubFetch(() => json(400, JSON.stringify({ error: { message: 'Invalid schema for function get_ticket', type: 'invalid_request_error' } })));
    const p = new OpenAICompatibleProvider('http://vllm:8000/v1', undefined, 'llama');
    const err = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUpstreamError);
    const e = err as AiUpstreamError;
    expect(e.statusCode).toBe(502);
    expect(e.code).toBe('ai_upstream');
    expect(e.upstreamStatus).toBe(400);
    expect(e.upstreamMessage).toBe('Invalid schema for function get_ticket');
    expect(e.message).toContain('HTTP 400');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('wraps 401 and network failures', async () => {
    stubFetch(() => json(401, JSON.stringify({ error: { message: 'Incorrect API key provided' } })));
    const p = new OpenAICompatibleProvider('https://api.openai.com/v1', 'sk-bad', 'gpt-4o-mini');
    await expect(p.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ upstreamStatus: 401, upstreamMessage: 'Incorrect API key provided' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(p.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ upstreamStatus: null, code: 'ai_upstream' });
  });

  it('never sends assistant content null without tool calls, and maps tool calls', async () => {
    const calls = stubFetch(() => json(200, JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":"vpn"}' } }] }, finish_reason: 'tool_calls' }] })));
    const p = new OpenAICompatibleProvider('http://lmstudio:1234/v1', undefined, 'local');
    const res = await p.chat({
      system: 's',
      messages: [
        { role: 'user', content: 'find vpn tickets' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'again' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'search', input: { q: 'x' } }] },
        { role: 'tool', toolCallId: 'c0', name: 'search', content: '[]' },
      ],
      tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    });
    const messages = calls[0]!.body.messages as Record<string, unknown>[];
    expect(messages[2]).toEqual({ role: 'assistant', content: '' });
    expect(messages[4]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function' }] });
    expect(messages[5]).toMatchObject({ role: 'tool', tool_call_id: 'c0' });
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'search', input: { q: 'vpn' } }]);
  });
});

describe('resolveAiConfig', () => {
  const base = { AI_PROVIDER: 'none' as const, AI_MODEL: 'claude-opus-5-5', ANTHROPIC_API_KEY: undefined, OPENAI_COMPATIBLE_BASE_URL: undefined, OPENAI_COMPATIBLE_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined };

  it('stays disabled without any key', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    expect(resolveAiConfig(base).provider).toBe('none');
  });

  it('infers OpenAI from OPENAI_API_KEY alone, with the OpenAI endpoint and a GPT model', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    const c = resolveAiConfig({ ...base, OPENAI_API_KEY: 'sk-test' });
    expect(c).toMatchObject({ provider: 'openai_compatible', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', hasKey: true });
    expect(c.notes.join(' ')).toMatch(/AI_PROVIDER not set/);
  });

  it('keeps an explicit OpenAI model and normalises the base URL', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    const c = resolveAiConfig({ ...base, AI_PROVIDER: 'openai_compatible', AI_MODEL: 'gpt-4o', OPENAI_COMPATIBLE_BASE_URL: 'https://api.openai.com/', OPENAI_COMPATIBLE_API_KEY: 'sk-x' });
    expect(c).toMatchObject({ provider: 'openai_compatible', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' });
  });

  it('never sends a Claude model id to api.openai.com but keeps custom models for local servers', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    expect(resolveAiConfig({ ...base, AI_PROVIDER: 'openai_compatible', AI_MODEL: 'claude-3-opus', OPENAI_COMPATIBLE_API_KEY: 'sk-x' }).model).toBe('gpt-4o-mini');
    expect(resolveAiConfig({ ...base, AI_PROVIDER: 'openai_compatible', AI_MODEL: 'llama3.1', OPENAI_COMPATIBLE_BASE_URL: 'http://ollama:11434/v1' }).model).toBe('llama3.1');
  });

  it('infers Anthropic from ANTHROPIC_API_KEY and rejects a GPT model for it', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    expect(resolveAiConfig({ ...base, ANTHROPIC_API_KEY: 'ak' })).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(resolveAiConfig({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak', AI_MODEL: 'gpt-4o' }).model).toBe('claude-opus-5-5');
  });

  it('reports a misconfiguration instead of enabling a broken provider', async () => {
    const { resolveAiConfig } = await import('../src/lib/ai/index');
    const c = resolveAiConfig({ ...base, AI_PROVIDER: 'anthropic' });
    expect(c.provider).toBe('none');
    expect(c.notes[0]).toMatch(/ANTHROPIC_API_KEY is empty/);
  });
});

describe('AnthropicProvider request shape', () => {
  const tools = [
    { name: 'a', description: 'first', inputSchema: { type: 'object', properties: {} } },
    { name: 'b', description: 'last', inputSchema: { type: 'object', properties: {} } },
  ];

  it('knows which models accept sampling parameters and which take effort', () => {
    expect(modelProfile('claude-opus-5-5')).toEqual({ sampling: false, effort: true });
    expect(modelProfile('claude-sonnet-5-5')).toEqual({ sampling: false, effort: true });
    expect(modelProfile('claude-fable-5-1')).toEqual({ sampling: false, effort: true });
    expect(modelProfile('claude-opus-4-7')).toEqual({ sampling: false, effort: true });
    expect(modelProfile('claude-opus-4-6')).toEqual({ sampling: true, effort: true });
    expect(modelProfile('claude-sonnet-4-5')).toEqual({ sampling: true, effort: false });
    expect(modelProfile('claude-sonnet-4-20250514')).toEqual({ sampling: true, effort: false });
    expect(modelProfile('claude-haiku-4-5')).toEqual({ sampling: true, effort: false });
    expect(modelProfile('claude-3-5-sonnet-20241022')).toEqual({ sampling: true, effort: false });
  });

  it('omits temperature and sets effort for Claude 5, with cache breakpoints on the stable system block and the last tool', () => {
    const p = new AnthropicProvider('key', 'claude-opus-5-5');
    const params = p.buildParams({ system: { stable: 'STABLE', volatile: 'VOLATILE' }, messages: [{ role: 'user', content: 'hi' }], tools, temperature: 0, effort: 'low', maxTokens: 100 });
    expect(params).not.toHaveProperty('temperature');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.max_tokens).toBe(100);
    expect(params.system).toEqual([
      { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VOLATILE' },
    ]);
    expect(params.tools![0]).not.toHaveProperty('cache_control');
    expect(params.tools![1]).toMatchObject({ name: 'b', cache_control: { type: 'ephemeral' } });
  });

  it('keeps temperature for models that accept it and caches a plain system string', () => {
    const p = new AnthropicProvider('key', 'claude-sonnet-4-5');
    const params = p.buildParams({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], temperature: 0, effort: 'low' });
    expect(params.temperature).toBe(0);
    expect(params).not.toHaveProperty('output_config');
    expect(params.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(params).not.toHaveProperty('tools');
  });

  it('replays the raw content blocks of an earlier reply so thinking blocks accompany their tool use', () => {
    const p = new AnthropicProvider('key', 'claude-opus-5-5');
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'tu1', name: 'a', input: {} },
    ];
    const params = p.buildParams({
      system: 'S',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tu1', name: 'a', input: {} }], raw },
        { role: 'tool', toolCallId: 'tu1', name: 'a', content: '{"ok":true}' },
      ],
    });
    expect(params.messages[1]).toEqual({ role: 'assistant', content: raw });
    expect(params.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{"ok":true}', is_error: undefined }] });
  });
});
