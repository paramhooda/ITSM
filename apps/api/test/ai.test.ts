import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { AppError } from '../src/core/errors';
import { createTicket, resolveTicket } from '../src/modules/tickets/service';
import type { AiProvider, ChatOptions, ChatResponse } from '../src/lib/ai';
import { availableTools, toolAvailable, toolByName, toolJsonSchema, ALL_TOOLS, ACTION_TOOLS } from '../src/modules/ai/tools';
import * as ai from '../src/modules/ai/service';
import * as sug from '../src/modules/ai/suggestions';

/**
 * DB-backed tests for the AI module. The provider is disabled in the test
 * environment (AI_PROVIDER=none) so the deterministic fallbacks are exercised;
 * the tool loop is validated with an injected fake provider.
 */
const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-ai-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let customerUser: Principal;
const ids = { a: '', b: '', siteA: '', service: '', userA: '', backupCat: '' };
const ticketIds: string[] = [];
const numbers: Record<string, string> = {};

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asCustomer = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(customerUser, meta, fn);

async function principalFor(email: string) {
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1));
  invalidatePrincipal(u!.id);
  const p = await loadPrincipal(u!.id);
  if (!p) throw new Error(`principal not loaded for ${email}`);
  return p;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [ca] = await tx.insert(schema.customers).values({ code: `AIA${S.toUpperCase()}`, name: `AI Customer Alpha ${S}` }).returning();
    const [cb] = await tx.insert(schema.customers).values({ code: `AIB${S.toUpperCase()}`, name: `AI Customer Beta ${S}` }).returning();
    ids.a = ca!.id;
    ids.b = cb!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: ca!.id, code: 'HQ', name: `Alpha HQ ${S}`, isPrimary: true }).returning();
    ids.siteA = site!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `ai_svc_${S}`, name: `Backup Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const [u] = await tx.insert(schema.users).values({ email: `ai-customer-${S}@test.local`, name: 'AI Portal User', userType: 'customer', customerId: ca!.id, status: 'active' }).returning({ id: schema.users.id });
    ids.userA = u!.id;
    await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: role!.id });
    const [cat] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(eq(schema.configOptions.key, 'backup')).limit(1);
    ids.backupCat = cat?.id ?? '';
  });
  admin = await principalFor('admin@msp.local');
  customerUser = await principalFor(`ai-customer-${S}@test.local`);

  // tickets: two similar open incidents for A (duplicates), one resolved with notes, three recurring backup incidents, and one for B
  const make = (ctx: Ctx, customerId: string, title: string, extra: Record<string, unknown> = {}) => createTicket(ctx, { type: 'incident', customerId, title, description: 'Nightly job failed with error 0x80004005 on the backup server. All users affected at the site.', serviceId: ids.service, siteId: customerId === ids.a ? ids.siteA : null, categoryId: ids.backupCat || null, ...extra });
  await asAdmin(async (ctx) => {
    const t1 = await make(ctx, ids.a, `Backup job failed on BKP-01 ${S}`);
    const t2 = await make(ctx, ids.a, `Backup job failing on BKP-01 again ${S}`);
    const t3 = await make(ctx, ids.a, `Backup job failed on BKP-01 (third time) ${S}`);
    const t4 = await make(ctx, ids.a, `Backup restore test failed ${S}`);
    const tb = await make(ctx, ids.b, `Backup job failed on BKP-99 ${S}`);
    ticketIds.push(t1.id, t2.id, t3.id, t4.id, tb.id);
    numbers.a1 = t1.number;
    numbers.a2 = t2.number;
    numbers.b = tb.number;
    await resolveTicket(ctx, t4.id, { resolutionNotes: 'Cleared the stale snapshot chain. Restarted the backup agent service. Re-ran the job successfully.' });
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.userId, [admin.id, ids.userA]));
    if (ticketIds.length) await tx.delete(schema.aiSuggestions).where(inArray(schema.aiSuggestions.entityId, ticketIds));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.a, ids.b]));
    await tx.delete(schema.users).where(eq(schema.users.id, ids.userA));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('tool registry', () => {
  it('exposes JSON schemas the provider understands', () => {
    const js = toolJsonSchema(toolByName('list_tickets')!.inputSchema);
    expect(js.type).toBe('object');
    expect(js.$schema).toBeUndefined();
    expect((js.properties as Record<string, unknown>).limit).toBeDefined();
    expect(ALL_TOOLS.map((t) => t.name)).toContain('create_ticket');
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(ALL_TOOLS.length);
  });

  it('filters tools by the principal permissions (admin vs customer user)', async () => {
    const adminTools = await asAdmin(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(adminTools).toEqual(expect.arrayContaining(['search', 'list_tickets', 'get_ticket', 'list_customers', 'get_customer', 'get_ci', 'impact_analysis', 'my_workload', 'out_of_scope_work', 'create_ticket', 'assign_ticket', 'set_status', 'link_tickets']));
    const portalTools = await asCustomer(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(portalTools).toEqual(expect.arrayContaining(['list_tickets', 'get_ticket', 'ticket_timeline', 'knowledge_search', 'sla_compliance', 'entitlement_usage', 'list_contracts', 'create_ticket', 'add_comment', 'upcoming_maintenance']));
    for (const forbidden of ['list_customers', 'get_customer', 'get_ci', 'ci_history', 'impact_analysis', 'my_workload', 'assign_ticket', 'set_status', 'link_tickets', 'engineer_directory', 'problem_candidates']) expect(portalTools).not.toContain(forbidden);
  });

  it('hides action tools without ai:act', async () => {
    const noAct: Principal = { ...admin, globalPermissions: new Set([...admin.globalPermissions].filter((p) => p !== 'ai:act')) };
    const names = await runAs(noAct, meta, async (ctx) => availableTools(ctx).map((t) => t.name));
    for (const t of ACTION_TOOLS) expect(names).not.toContain(t.name);
    expect(names).toContain('list_tickets');
    const ok = await runAs(noAct, meta, async (ctx) => toolAvailable(ctx, toolByName('create_ticket')!));
    expect(ok).toBe(false);
  });
});

describe('read tools respect tenant scope', () => {
  it('list_tickets for a customer user only returns their own tickets, even when asking for another customer', async () => {
    const tool = toolByName('list_tickets')!;
    const res = (await asCustomer((ctx) => tool.run(ctx, { customer: `AI Customer Beta ${S}`, openOnly: false }))) as { items: { number: string; customer: string }[] };
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((t) => t.customer === `AI Customer Alpha ${S}`)).toBe(true);
    expect(res.items.map((t) => t.number)).not.toContain(numbers.b);
    const adminRes = (await asAdmin((ctx) => tool.run(ctx, { customer: `AIB${S.toUpperCase()}`, openOnly: false }))) as { items: { number: string }[] };
    expect(adminRes.items.map((t) => t.number)).toEqual([numbers.b]);
  });

  it('get_ticket resolves by number and hides other customers from portal users', async () => {
    const tool = toolByName('get_ticket')!;
    const d = (await asAdmin((ctx) => tool.run(ctx, { ticket: numbers.a1.toLowerCase() }))) as { number: string; link: string; recentTimeline: unknown[] };
    expect(d.number).toBe(numbers.a1);
    expect(d.link).toBe(`/tickets/${ticketIds[0]}`);
    const portal = (await asCustomer((ctx) => tool.run(ctx, { ticket: numbers.a1 }))) as { link: string };
    expect(portal.link).toBe(`/portal/tickets/${ticketIds[0]}`);
    await expect(asCustomer((ctx) => tool.run(ctx, { ticket: numbers.b }))).rejects.toBeInstanceOf(AppError);
  });

  it('executeToolCall isolates failures under a savepoint and keeps the transaction usable', async () => {
    const out = await asAdmin(async (ctx) => {
      const bad = await ai.executeToolCall(ctx, { id: 'c1', name: 'get_ticket', input: { ticket: 'INC-999999' } }, 0);
      const invalid = await ai.executeToolCall(ctx, { id: 'c2', name: 'list_tickets', input: { limit: 500 } }, 1);
      const unknown = await ai.executeToolCall(ctx, { id: 'c3', name: 'drop_everything', input: {} }, 2);
      const good = await ai.executeToolCall(ctx, { id: 'c4', name: 'get_ticket', input: { ticket: numbers.a1 } }, 3);
      return { bad, invalid, unknown, good };
    });
    expect(out.bad.isError).toBe(true);
    expect(out.bad.record.ok).toBe(false);
    expect(out.invalid.record.error).toBe('validation_error');
    expect(out.unknown.record.error).toBe('unknown_tool');
    expect(out.good.isError).toBe(false);
    expect(out.good.record.summary).toContain(numbers.a1);
  });
});

describe('action tools', () => {
  it('create_ticket is refused without ai:act and forces a customer user onto their own customer', async () => {
    const tool = toolByName('create_ticket')!;
    const noAct: Principal = { ...customerUser, globalPermissions: new Set([...customerUser.globalPermissions].filter((p) => p !== 'ai:act')) };
    const refused = await runAs(noAct, meta, (ctx) => ai.executeToolCall(ctx, { id: 'x', name: 'create_ticket', input: { type: 'incident', title: 'Should not be created' } }, 0));
    expect(refused.isError).toBe(true);
    expect(refused.record.error).toBe('forbidden');

    const created = (await asCustomer((ctx) => tool.run(ctx, { customer: `AI Customer Beta ${S}`, type: 'incident', title: `Network down at Alpha HQ ${S}`, site: `Alpha HQ ${S}`, priority: 'p1' }))) as { number: string; id: string; customer: string; link: string };
    ticketIds.push(created.id);
    expect(created.customer).toBe(`AI Customer Alpha ${S}`);
    expect(created.number).toMatch(/^INC-\d+$/);
    expect(created.link).toBe(`/portal/tickets/${created.id}`);
    const [row] = await withSystem((tx) => tx.select({ customerId: schema.tickets.customerId, siteId: schema.tickets.siteId, priorityId: schema.tickets.priorityId, requesterUserId: schema.tickets.requesterUserId }).from(schema.tickets).where(eq(schema.tickets.id, created.id)));
    expect(row!.customerId).toBe(ids.a);
    expect(row!.siteId).toBe(ids.siteA);
    expect(row!.requesterUserId).toBe(ids.userA);
    // portal users cannot pick a priority
    const [p3] = await withSystem((tx) => tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(eq(schema.configOptions.key, 'p1')));
    expect(row!.priorityId).not.toBe(p3!.id);
  });

  it('add_comment through the AI ctx is audited with source = ai and never internal for portal users', async () => {
    const tool = toolByName('add_comment')!;
    const res = (await asCustomer((ctx) => ai.withAiCtx(ctx, (a) => tool.run(a, { ticket: numbers.a1, body: `Any update? ${S}`, internal: true })))) as { commentId: string; visibleToCustomer: boolean };
    expect(res.visibleToCustomer).toBe(true);
    const [c] = await withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.id, res.commentId)));
    expect(c!.isInternal).toBe(false);
    expect(c!.source).toBe('ai');
    const audits = await withSystem((tx) => tx.select({ source: schema.auditLog.source, action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.requestId, meta.requestId)));
    expect(audits.some((a) => a.action === 'ticket.comment' && a.source === 'ai')).toBe(true);
  });
});

describe('AI-assisted ITSM fallbacks (provider disabled)', () => {
  it('reports the provider as disabled', async () => {
    const st = await asAdmin((ctx) => ai.status(ctx));
    expect(st.enabled).toBe(false);
    expect(st.provider).toBe('none');
    expect(Array.isArray(st.features)).toBe(true);
    expect(st.suggestions.length).toBeGreaterThan(0);
    const portal = await asCustomer((ctx) => ai.status(ctx));
    expect(portal.suggestions.some((s) => /maintenance/i.test(s))).toBe(true);
    expect(portal.suggestions.some((s) => s.includes(`Alpha HQ ${S}`))).toBe(true);
  });

  it('summarize returns a template summary with facts and next steps', async () => {
    const res = await asAdmin((ctx) => sug.summarize(ctx, ticketIds[0]!));
    expect(res.aiGenerated).toBe(false);
    expect(res.summary).toContain(numbers.a1);
    expect(res.keyFacts.length).toBeGreaterThan(1);
    expect(res.nextSteps.length).toBeGreaterThan(0);
    expect(res.suggestionId).toMatch(/[0-9a-f-]{36}/);
  });

  it('classify uses keyword heuristics and the priority matrix', async () => {
    const res = await asAdmin((ctx) => sug.classify(ctx, ticketIds[0]!));
    expect(res.aiGenerated).toBe(false);
    expect(res.categoryKey).toBe('backup');
    expect(res.subcategoryKey).toBe('job_failure');
    expect(res.impactKey).toBe('high');
    expect(res.priorityKey).toBeTruthy();
    expect(res.confidence).toBeGreaterThan(0);
    const draft = await asAdmin((ctx) => sug.classifyDraft(ctx, { title: 'Cannot login, password reset needed for one user', description: 'no rush' }));
    expect(draft.categoryKey).toBe('access');
    expect(draft.urgencyKey).toBe('low');
  });

  it('duplicate-check finds the similar open ticket of the same customer only', async () => {
    const res = await asAdmin((ctx) => sug.duplicateCheck(ctx, ticketIds[0]!));
    const nums = res.items.map((i) => i.number);
    expect(nums).toContain(numbers.a2);
    expect(nums).not.toContain(numbers.b);
    expect(res.items[0]!.score).toBeGreaterThan(0.3);
    expect(res.items[0]!.reasons.length).toBeGreaterThan(0);
  });

  it('recommend-assignment returns a structure with rationale and alternatives', async () => {
    const res = await asAdmin((ctx) => sug.recommendAssignment(ctx, ticketIds[1]!));
    expect(res).toHaveProperty('teamKey');
    expect(res).toHaveProperty('userId');
    expect(typeof res.rationale).toBe('string');
    expect(Array.isArray(res.alternatives)).toBe(true);
    await expect(asCustomer((ctx) => sug.recommendAssignment(ctx, ticketIds[1]!))).rejects.toBeInstanceOf(AppError);
  });

  it('resolution suggestions extract steps from resolved similar tickets', async () => {
    const res = await asAdmin((ctx) => sug.resolutionSuggestions(ctx, ticketIds[0]!));
    expect(res.aiGenerated).toBe(false);
    const fromTicket = res.suggestions.find((s) => s.source === 'ticket');
    expect(fromTicket).toBeDefined();
    expect(fromTicket!.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('draft customer update produces a template addressed to the requester', async () => {
    const res = await asAdmin((ctx) => sug.draftCustomerUpdate(ctx, ticketIds[0]!, 'apologetic'));
    expect(res.aiGenerated).toBe(false);
    expect(res.draft).toContain(numbers.a1);
    expect(res.draft).toMatch(/sorry/i);
  });

  it('problem clusters group the recurring backup incidents', async () => {
    const res = await asAdmin((ctx) => sug.problemClusters(ctx, { days: 7, customerId: ids.a, minCount: 3 }));
    expect(res.clusters.length).toBeGreaterThanOrEqual(1);
    const c = res.clusters[0]!;
    expect(c.customerName).toBe(`AI Customer Alpha ${S}`);
    expect(c.count).toBeGreaterThanOrEqual(3);
    expect(c.suggestedTitle.length).toBeGreaterThan(10);
    expect(c.sampleTickets[0]!.link).toMatch(/^\/tickets\//);
    await expect(asCustomer((ctx) => sug.problemClusters(ctx, { days: 7 }))).rejects.toBeInstanceOf(AppError);
  });

  it('stores suggestions and records decisions', async () => {
    const res = await asAdmin((ctx) => sug.classify(ctx, ticketIds[0]!));
    const decided = await asAdmin((ctx) => sug.decide(ctx, res.suggestionId, 'accepted', 'looks right'));
    expect(decided.status).toBe('accepted');
    const list = await asAdmin((ctx) => sug.listSuggestions(ctx, ticketIds[0]!, 'classification'));
    const row = list.items.find((i) => i.id === res.suggestionId)!;
    expect(row.status).toBe('accepted');
    expect(row.decidedBy).toBe(admin.id);
    // ticket itself is untouched: the UI applies accepted suggestions through the ticket endpoints
    const [t] = await withSystem((tx) => tx.select({ impactId: schema.tickets.impactId }).from(schema.tickets).where(eq(schema.tickets.id, ticketIds[0]!)));
    expect(t!.impactId).toBeNull();
  });

  it('chat without a provider fails with 503 ai_disabled', async () => {
    let caught: unknown;
    try {
      await asAdmin((ctx) => ai.chat(ctx, { message: 'hello' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(503);
    expect((caught as AppError).code).toBe('ai_disabled');
  });
});

describe('tool loop with a fake provider', () => {
  class FakeProvider implements AiProvider {
    readonly name = 'fake';
    readonly model = 'fake-1';
    calls: ChatOptions[] = [];
    async chat(opts: ChatOptions): Promise<ChatResponse> {
      this.calls.push(opts);
      const last = opts.messages[opts.messages.length - 1]!;
      if (last.role === 'user') {
        expect(opts.tools?.some((t) => t.name === 'list_tickets')).toBe(true);
        return { text: '', toolCalls: [{ id: 'call_1', name: 'list_tickets', input: { customer: `AIA${S.toUpperCase()}`, openOnly: true, limit: 5 } }, { id: 'call_2', name: 'assign_ticket', input: { ticket: numbers.a1, engineer: 'me' } }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
      }
      const results = opts.messages.filter((m) => m.role === 'tool') as { name: string; content: string; isError?: boolean }[];
      const list = JSON.parse(results.find((r) => r.name === 'list_tickets')!.content) as { items: { number: string; link: string }[] };
      return { text: `There are ${list.items.length} open tickets. First: [${list.items[0]!.number}](${list.items[0]!.link}). Assigned ${numbers.a1} to you.`, toolCalls: [], stopReason: 'end', usage: { inputTokens: 20, outputTokens: 15 } };
    }
  }

  it('runs tool calls, persists the conversation and reports actions', async () => {
    const fake = new FakeProvider();
    ai.setProviderForTests(fake);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `What is open for AIA${S.toUpperCase()} and assign the first one to me`, context: { label: numbers.a1, entityType: 'ticket', entityId: ticketIds[0] } }));
      expect(fake.calls.length).toBe(2);
      expect(fake.calls[0]!.system).toContain('Current screen');
      expect(fake.calls[0]!.system).toContain(numbers.a1);
      expect(fake.calls[0]!.system).not.toMatch(/api[_-]?key|secret/i);
      expect(res.message.role).toBe('assistant');
      expect(res.message.content).toMatch(/\[INC-\d+\]\(\/tickets\/[0-9a-f-]{36}\)/);
      expect(res.message.toolCalls.map((t) => t.name)).toEqual(['list_tickets', 'assign_ticket']);
      expect(res.message.toolCalls.every((t) => t.ok)).toBe(true);
      expect(res.message.toolCalls[1]!.action).toBe(true);
      expect(res.usage.inputTokens).toBe(30);

      const conv = await asAdmin((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(conv.title!.length).toBeLessThanOrEqual(60);
      const mine = await asAdmin((ctx) => ai.listConversations(ctx));
      expect(mine.items.some((c) => c.id === res.conversationId)).toBe(true);
      expect(mine.items.find((c) => c.id === res.conversationId)!.messageCount).toBe(2);
      // the conversation is private to its owner
      await expect(asCustomer((ctx) => ai.getConversation(ctx, res.conversationId))).rejects.toBeInstanceOf(AppError);
      // the action happened through the service layer with source = ai
      const [t] = await withSystem((tx) => tx.select({ assigneeId: schema.tickets.assigneeId }).from(schema.tickets).where(eq(schema.tickets.id, ticketIds[0]!)));
      expect(t!.assigneeId).toBe(admin.id);
      const audits = await withSystem((tx) => tx.select({ source: schema.auditLog.source, action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.entityId, ticketIds[0]!)));
      expect(audits.some((a) => a.action === 'ticket.assign' && a.source === 'ai')).toBe(true);

      // follow-up turn reuses history
      const second = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'thanks' }));
      expect(fake.calls[2]!.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(2);
      expect(second.conversationId).toBe(res.conversationId);
      await asAdmin((ctx) => ai.deleteConversation(ctx, res.conversationId));
      await expect(asAdmin((ctx) => ai.getConversation(ctx, res.conversationId))).rejects.toBeInstanceOf(AppError);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('stops after the iteration limit when the model keeps calling tools', async () => {
    const looping: AiProvider = { name: 'fake', model: 'loop', chat: async () => ({ text: '', toolCalls: [{ id: 'x', name: 'ticket_stats', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }) };
    ai.setProviderForTests(looping);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'loop' }));
      expect(res.message.toolCalls.length).toBe(ai.MAX_TOOL_ITERATIONS);
      expect(res.message.content).toMatch(/limit/i);
      await asAdmin((ctx) => ai.deleteConversation(ctx, res.conversationId));
    } finally {
      ai.setProviderForTests(null);
    }
  });
});
