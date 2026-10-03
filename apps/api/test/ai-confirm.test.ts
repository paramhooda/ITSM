/**
 * Propose-then-commit, bound to the action id (DB-backed). Run with the dev
 * environment sourced:
 *   npx vitest run test/ai-confirm.test.ts
 *
 * Guarantees under test:
 *   1. A confirmation names the action it decides; a different or expired id is refused.
 *   2. The action runs exactly once, even for two simultaneous confirmations.
 *   3. The side effects carry the action id in their audit metadata.
 *   4. Autonomy auto_low applies low-risk writes at once and still proposes everything else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, and, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { AppError } from '../src/core/errors';
import { systemText, type AiProvider, type ChatOptions, type ChatResponse } from '../src/lib/ai';
import * as ai from '../src/modules/ai/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-ai-confirm-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { customer: '', service: '' };
const ticketIds: string[] = [];
const numbers: Record<string, string> = {};
const conversations: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);

/** A scripted model: first turn calls the tools given, second turn answers with `answer(toolResults)`. */
function scripted(calls: { name: string; input: Record<string, unknown> }[], answer: (results: Record<string, string>) => string) {
  const seen: ChatOptions[] = [];
  const provider: AiProvider & { seen: ChatOptions[] } = {
    name: 'fake',
    model: 'fake-1',
    seen,
    async chat(opts: ChatOptions): Promise<ChatResponse> {
      seen.push({ ...opts, system: systemText(opts.system) });
      const last = opts.messages[opts.messages.length - 1]!;
      if (last.role === 'user') return { text: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, input: c.input })), stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
      const results: Record<string, string> = {};
      for (const m of opts.messages) if (m.role === 'tool') results[(m as { name: string }).name] = (m as { content: string }).content;
      return { text: answer(results), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return provider;
}
const proposeComment = (ticket: string, body: string) => scripted([{ name: 'add_comment', input: { ticket, body } }], (r) => `${(JSON.parse(r.add_comment!) as { preview: string }).preview}. Shall I proceed?`);
const countComments = async (ticketId: string) => (await withSystem((tx) => tx.select({ id: schema.ticketComments.id }).from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketId)))).length;
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never, updatedAt: new Date() } }));

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `CF${S.toUpperCase()}`, name: `Confirm Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `cf_svc_${S}`, name: `Confirm Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
  });
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1));
  invalidatePrincipal(u!.id);
  admin = (await loadPrincipal(u!.id))!;
  await asAdmin(async (ctx) => {
    const a = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Confirm fixture A ${S}`, description: 'fixture', serviceId: ids.service });
    const b = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Confirm fixture B ${S}`, description: 'fixture', serviceId: ids.service });
    ticketIds.push(a.id, b.id);
    numbers.a = a.number;
    numbers.b = b.number;
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await setSetting('ai.autonomy', 'confirm_all');
  await withSystem(async (tx) => {
    if (conversations.length) await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.id, conversations));
    await tx.delete(schema.tickets).where(eq(schema.tickets.customerId, ids.customer));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('confirmation bound to the action id', () => {
  it('runs exactly once when confirmed by id, stamps the id on the side effect, and refuses a second confirmation', async () => {
    const before = await countComments(ticketIds[0]!);
    ai.setProviderForTests(proposeComment(numbers.a!, `Engineer dispatched ${S}`));
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `comment on ${numbers.a}` }));
      conversations.push(res.conversationId);
      const action = res.pendingAction!;
      expect(action.tool).toBe('add_comment');
      expect(action.tier).toBe('write');
      expect(new Date(action.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(await countComments(ticketIds[0]!)).toBe(before);

      const yes = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: action.id, decision: 'confirm' } }));
      expect(yes.message.content).toMatch(/^Done: Added comment to /);
      expect(yes.pendingAction).toBeNull();
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
      // the transcript reads naturally: the button press is stored as a short user message
      const loaded = await asAdmin((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(loaded.messages[2]!.content).toBe('Yes, go ahead.');

      const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata, source: schema.auditLog.source }).from(schema.auditLog).where(and(eq(schema.auditLog.requestId, meta.requestId), sql`${schema.auditLog.metadata}->>'aiActionId' = ${action.id}`)));
      const sideEffects = audits.filter((a) => !a.action.startsWith('ai.'));
      expect(sideEffects.length).toBeGreaterThan(0);
      expect(sideEffects.every((a) => a.source === 'ai')).toBe(true);
      const toolAudit = await withSystem((tx) => tx.select({ metadata: schema.auditLog.metadata }).from(schema.auditLog).where(and(eq(schema.auditLog.requestId, meta.requestId), eq(schema.auditLog.action, 'ai.tool'), sql`${schema.auditLog.metadata}->>'actionId' = ${action.id}`)));
      expect(toolAudit.map((a) => (a.metadata as { outcome: string }).outcome).sort()).toEqual(['ok', 'proposed']);
      expect(toolAudit.every((a) => !('input' in (a.metadata as object)) && typeof (a.metadata as { inputHash: string }).inputHash === 'string')).toBe(true);

      // Nothing is waiting any more: the same button is refused and nothing runs again.
      await expect(asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: action.id, decision: 'confirm' } }))).rejects.toMatchObject({ statusCode: 409, code: 'stale_action' });
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('refuses a confirmation naming a different action and keeps the real one waiting; cancel by id drops it', async () => {
    const before = await countComments(ticketIds[0]!);
    ai.setProviderForTests(proposeComment(numbers.a!, `Wrong button ${S}`));
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `comment on ${numbers.a}` }));
      conversations.push(res.conversationId);
      const action = res.pendingAction!;
      await expect(asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: randomUUID(), decision: 'confirm' } }))).rejects.toMatchObject({ statusCode: 409, code: 'stale_action' });
      expect(await countComments(ticketIds[0]!)).toBe(before);
      const still = await asAdmin((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(still.pendingAction?.id).toBe(action.id);

      const no = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: action.id, decision: 'cancel' } }));
      expect(no.message.content).toBe('OK, I have not done that.');
      expect(no.pendingAction).toBeNull();
      expect(await countComments(ticketIds[0]!)).toBe(before);
      const gone = await asAdmin((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(gone.pendingAction).toBeNull();
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('two simultaneous confirmations run the action once', async () => {
    const before = await countComments(ticketIds[0]!);
    ai.setProviderForTests(proposeComment(numbers.a!, `Race ${S}`));
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `comment on ${numbers.a}` }));
      conversations.push(res.conversationId);
      const action = res.pendingAction!;
      const confirm = () => asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: action.id, decision: 'confirm' } }));
      const outcomes = await Promise.allSettled([confirm(), confirm()]);
      const done = outcomes.filter((o): o is PromiseFulfilledResult<ai.ChatResult> => o.status === 'fulfilled');
      const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(done).toHaveLength(1);
      expect(done[0]!.value.message.content).toMatch(/^Done: /);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(AppError);
      expect((refused[0]!.reason as AppError).code).toBe('stale_action');
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('a confirmation without a conversation, or on a conversation holding nothing, is stale', async () => {
    ai.setProviderForTests({ name: 'fake', model: 'x', chat: async () => ({ text: 'Hello.', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }) });
    try {
      await expect(asAdmin((ctx) => ai.chat(ctx, { confirm: { actionId: randomUUID(), decision: 'confirm' } }))).rejects.toMatchObject({ statusCode: 409, code: 'stale_action' });
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'hello' }));
      conversations.push(res.conversationId);
      await expect(asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: randomUUID(), decision: 'cancel' } }))).rejects.toMatchObject({ statusCode: 409, code: 'stale_action' });
    } finally {
      ai.setProviderForTests(null);
    }
  });
});

describe('autonomy', () => {
  it('auto_low applies a low-risk link at once and still proposes a status change', async () => {
    await setSetting('ai.autonomy', 'auto_low');
    const two = scripted(
      [
        { name: 'link_tickets', input: { ticket: numbers.a, target: numbers.b, linkType: 'related' } },
        { name: 'set_status', input: { ticket: numbers.a, status: 'pending_customer' } },
      ],
      () => 'Linked them. Shall I proceed with the status change?',
    );
    ai.setProviderForTests(two);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'link and pend' }));
      conversations.push(res.conversationId);
      expect(res.message.toolCalls.map((t) => [t.name, t.ok, t.proposed ?? false, t.auto ?? false])).toEqual([
        ['link_tickets', true, false, true],
        ['set_status', true, true, false],
      ]);
      expect(res.pendingAction?.tool).toBe('set_status');
      const links = await withSystem((tx) => tx.select({ id: schema.ticketLinks.id }).from(schema.ticketLinks).where(and(eq(schema.ticketLinks.sourceTicketId, ticketIds[0]!), eq(schema.ticketLinks.targetTicketId, ticketIds[1]!))));
      expect(links).toHaveLength(1);
      expect(two.seen[0]!.system).toContain('Autonomy: low-risk internal writes');
      await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: res.pendingAction!.id, decision: 'cancel' } }));
    } finally {
      ai.setProviderForTests(null);
      await setSetting('ai.autonomy', 'confirm_all');
    }
  });

  it('confirm_all (the default) proposes even a low-risk link', async () => {
    const link = scripted([{ name: 'link_tickets', input: { ticket: numbers.b, target: numbers.a, linkType: 'related' } }], () => 'Shall I proceed?');
    ai.setProviderForTests(link);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'link them' }));
      conversations.push(res.conversationId);
      expect(res.message.toolCalls[0]).toMatchObject({ name: 'link_tickets', ok: true, proposed: true });
      expect(res.pendingAction?.tier).toBe('write_low');
      expect(link.seen[0]!.system).not.toContain('Autonomy: low-risk');
      await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, confirm: { actionId: res.pendingAction!.id, decision: 'cancel' } }));
    } finally {
      ai.setProviderForTests(null);
    }
  });
});
