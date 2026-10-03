/**
 * The chat turn never holds a database connection while the model is working
 * (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/ai-transaction.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { pool, withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { AiUpstreamError, type AiProvider, type ChatOptions, type ChatResponse } from '../src/lib/ai';
import * as ai from '../src/modules/ai/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-ai-tx-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { customer: '', service: '' };
let ticketNumber = '';
const conversations: string[] = [];

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `TX${S.toUpperCase()}`, name: `Tx Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `tx_svc_${S}`, name: `Tx Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
  });
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1));
  invalidatePrincipal(u!.id);
  admin = (await loadPrincipal(u!.id))!;
  await runAs(admin, meta, async (ctx: Ctx) => {
    const t = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Tx fixture ${S}`, description: 'fixture', serviceId: ids.service });
    ticketNumber = t.number;
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    const mine = await tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(eq(schema.aiConversations.userId, admin.id));
    const toDelete = [...conversations, ...mine.filter((c) => !conversations.includes(c.id)).map((c) => c.id)].filter((id, i, a) => a.indexOf(id) === i);
    if (toDelete.length) await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.id, toDelete));
    await tx.delete(schema.tickets).where(eq(schema.tickets.customerId, ids.customer));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

/** What the pool looks like at the moment the model is "thinking". */
async function snapshot() {
  const busy = pool.totalCount - pool.idleCount;
  const res = await withSystem((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`));
  return { busy, idleInTransaction: Number((res.rows[0] as { n: number }).n) };
}

describe('transaction boundary', () => {
  it('holds no connection and leaves no transaction open while the model is called, before and after a tool call', async () => {
    const seen: { busy: number; idleInTransaction: number }[] = [];
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake-1',
      async chat(opts: ChatOptions): Promise<ChatResponse> {
        seen.push(await snapshot());
        const last = opts.messages[opts.messages.length - 1]!;
        if (last.role === 'user') return { text: '', toolCalls: [{ id: 'c1', name: 'get_ticket', input: { ticket: ticketNumber } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: `Looked at ${ticketNumber}.`, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    ai.setProviderForTests(provider);
    try {
      // Called directly (no surrounding runAs), the way the route does it.
      const res = await ai.chatTurn(admin, meta, { message: `look at ${ticketNumber}` });
      conversations.push(res.conversationId);
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.busy).toBe(0);
        expect(s.idleInTransaction).toBe(0);
      }
      expect(res.message.toolCalls[0]).toMatchObject({ name: 'get_ticket', ok: true });
      expect(res.message.content).toContain(ticketNumber);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('a tool that fails leaves the turn intact and is audited with its outcome', async () => {
    ai.setProviderForTests({
      name: 'fake',
      model: 'fake-1',
      async chat(opts: ChatOptions): Promise<ChatResponse> {
        const last = opts.messages[opts.messages.length - 1]!;
        if (last.role === 'user') return { text: '', toolCalls: [{ id: 'c1', name: 'get_ticket', input: { ticket: 'INC-999999' } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: 'I could not find that ticket.', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    try {
      const res = await ai.chatTurn(admin, meta, { message: 'look at INC-999999' });
      conversations.push(res.conversationId);
      expect(res.message.toolCalls[0]).toMatchObject({ name: 'get_ticket', ok: false, error: 'not_found' });
      expect(res.message.content).toBe('I could not find that ticket.');
      const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata }).from(schema.auditLog).where(eq(schema.auditLog.requestId, meta.requestId)));
      expect(audits.some((a) => a.action === 'ai.tool' && (a.metadata as { outcome: string }).outcome === 'error')).toBe(true);
      expect(audits.some((a) => a.action === 'ai.chat' && (a.metadata as { outcome: string }).outcome === 'answered')).toBe(true);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('a model failure undoes the question so a retry does not duplicate it', async () => {
    ai.setProviderForTests({
      name: 'fake',
      model: 'fake-1',
      async chat(): Promise<ChatResponse> {
        throw new AiUpstreamError('fake', 503, 'overloaded', 'fake-1');
      },
    });
    try {
      await expect(ai.chatTurn(admin, meta, { message: `unanswerable ${S}` })).rejects.toBeInstanceOf(AiUpstreamError);
      const [conv] = await withSystem((tx) => tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(eq(schema.aiConversations.title, `unanswerable ${S}`)).limit(1));
      expect(conv).toBeDefined();
      conversations.push(conv!.id);
      const messages = await withSystem((tx) => tx.select({ id: schema.aiMessages.id }).from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conv!.id)));
      expect(messages).toHaveLength(0);
    } finally {
      ai.setProviderForTests(null);
    }
  });
});
