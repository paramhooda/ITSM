import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/core/app';
import { closeDb } from '../src/db/client';
import * as ai from '../src/modules/ai/service';
import type { AiProvider, ChatOptions, ChatResponse } from '../src/lib/ai';

/** The streamed chat route: progress events, then the reply; errors end the stream with an error event. */

class ScriptedProvider implements AiProvider {
  name = 'scripted';
  model = 'scripted';
  calls: ChatOptions[] = [];
  async chat(opts: ChatOptions): Promise<ChatResponse> {
    this.calls.push(opts);
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'tool') return { text: 'Here is your application guide.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end' };
    return { text: '', toolCalls: [{ id: 'c1', name: 'app_guide', input: { question: 'tickets' } }], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_use' };
  }
}

const parse = (body: string) => body.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((b) => {
  const event = /event: (\w+)/.exec(b)?.[1] ?? 'message';
  const data = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  return { event, data: JSON.parse(data) as Record<string, unknown> };
});

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@msp.local', password: 'Admin@12345' } });
  token = (login.json() as { accessToken: string }).accessToken;
});
afterAll(async () => {
  ai.setProviderForTests(null);
  await app.close();
  await closeDb();
});

describe('streamed chat', () => {
  it('sends open, turn, toolsets, step and message events, and the JSON route still answers without the header', async () => {
    ai.setProviderForTests(new ScriptedProvider());
    const res = await app.inject({ method: 'POST', url: '/api/ai/chat', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, payload: { message: 'where are the tickets?', context: { page: { pathname: '/tickets', query: { priority: 'p1' } } } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parse(res.body);
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('open');
    expect(kinds).toContain('turn');
    expect(kinds).toContain('toolsets');
    expect(kinds.filter((k) => k === 'step')).toHaveLength(2);
    expect(kinds[kinds.length - 1]).toBe('message');
    const steps = events.filter((e) => e.event === 'step').map((e) => e.data);
    expect(steps[0]).toMatchObject({ tool: 'app_guide', status: 'start', action: false });
    expect(steps[1]).toMatchObject({ tool: 'app_guide', status: 'done' });
    const message = events[events.length - 1]!.data as { conversationId: string; message: { content: string; toolCalls: { name: string }[] }; uiActions: unknown[] };
    expect(message.message.content).toContain('application guide');
    expect(message.message.toolCalls.map((t) => t.name)).toEqual(['app_guide']);
    const sets = events.find((e) => e.event === 'toolsets')!.data as { active: string[] };
    expect(sets.active).toContain('tickets');
    // JSON stays the default
    const plain = await app.inject({ method: 'POST', url: '/api/ai/chat', headers: { authorization: `Bearer ${token}` }, payload: { conversationId: message.conversationId, message: 'and again?' } });
    expect(plain.statusCode).toBe(200);
    expect((plain.json() as { conversationId: string }).conversationId).toBe(message.conversationId);
  });

  it('ends the stream with an error event when the turn fails', async () => {
    ai.setProviderForTests(new ScriptedProvider());
    const res = await app.inject({ method: 'POST', url: '/api/ai/chat', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, payload: { conversationId: '00000000-0000-0000-0000-000000000000', message: 'hello' } });
    expect(res.statusCode).toBe(200);
    const events = parse(res.body);
    const err = events.find((e) => e.event === 'error')!.data as { statusCode: number; error: string };
    expect(err.statusCode).toBe(404);
    expect(events[events.length - 1]!.event).toBe('error');
  });
});
