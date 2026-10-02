/**
 * Customer data isolation in the assistant (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/ai-isolation.test.ts
 *
 * Two organisations, Alpha and Beta, with deliberately look-alike data. Every tool
 * a portal user can reach is called as Alpha's user with inputs that ask for Beta,
 * and must come back with Alpha's data only. The tenant fence is then tested on
 * its own and against a principal whose scope is deliberately wrong, to prove it
 * holds even if an upstream check were broken. Finally the prompt and the stored
 * conversations are checked for the same guarantees.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { AppError } from '../src/core/errors';
import { createTicket, resolveTicket } from '../src/modules/tickets/service';
import * as kb from '../src/modules/knowledge/service';
import type { AiProvider, ChatOptions, ChatResponse } from '../src/lib/ai';
import { z } from 'zod';
import { availableTools, toolByName, ALL_TOOLS, type AiTool } from '../src/modules/ai/tools';
import { buildSystemPrompt, describeScope } from '../src/modules/ai/prompts';
import { fenceToolResult, belongsElsewhere, fenceAnswer, collectSeen, ANSWER_FENCE_NOTE } from '../src/modules/ai/fence';
import * as ai from '../src/modules/ai/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-ai-iso-${S}`, ip: '127.0.0.1' };
const ALPHA = `Alpha Isolation ${S}`;
const BETA = `Beta Isolation ${S}`;
const ALPHA_CODE = `ISA${S.toUpperCase()}`;
const BETA_CODE = `ISB${S.toUpperCase()}`;
let admin: Principal;
let alphaUser: Principal;
const ids = { a: '', b: '', siteA: '', siteB: '', service: '', userA: '', contractA: '', contractB: '' };
const ticketIds: string[] = [];
const articleIds: string[] = [];
const numbers: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asAlpha = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alphaUser, meta, fn);
const text = (v: unknown) => JSON.stringify(v);

async function principalFor(email: string) {
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1));
  invalidatePrincipal(u!.id);
  const p = await loadPrincipal(u!.id);
  if (!p) throw new Error(`principal not loaded for ${email}`);
  return p;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [ca] = await tx.insert(schema.customers).values({ code: ALPHA_CODE, name: ALPHA }).returning();
    const [cb] = await tx.insert(schema.customers).values({ code: BETA_CODE, name: BETA }).returning();
    ids.a = ca!.id;
    ids.b = cb!.id;
    const [siteA] = await tx.insert(schema.sites).values({ customerId: ca!.id, code: 'HQ', name: `Alpha HQ ${S}`, isPrimary: true }).returning();
    const [siteB] = await tx.insert(schema.sites).values({ customerId: cb!.id, code: 'HQ', name: `Beta HQ ${S}`, isPrimary: true }).returning();
    ids.siteA = siteA!.id;
    ids.siteB = siteB!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `iso_svc_${S}`, name: `Firewall Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const [u] = await tx.insert(schema.users).values({ email: `iso-alpha-${S}@test.local`, name: 'Alpha Portal User', userType: 'customer', customerId: ca!.id, status: 'active' }).returning({ id: schema.users.id });
    ids.userA = u!.id;
    await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: role!.id, customerId: ca!.id });
    // Contracts and entitlements for both organisations.
    const [ka] = await tx.insert(schema.contracts).values({ customerId: ca!.id, number: `ISO-A-${S}`, name: `Alpha support ${S}`, status: 'active', startDate: day(-30), endDate: day(40), slaPolicyId: policy?.id ?? null, escalationMatrix: [] }).returning();
    const [kbc] = await tx.insert(schema.contracts).values({ customerId: cb!.id, number: `ISO-B-${S}`, name: `Beta support ${S}`, status: 'active', startDate: day(-30), endDate: day(20), slaPolicyId: policy?.id ?? null, escalationMatrix: [] }).returning();
    ids.contractA = ka!.id;
    ids.contractB = kbc!.id;
    await tx.insert(schema.contractServices).values([
      { contractId: ka!.id, customerId: ca!.id, serviceId: svc!.id },
      { contractId: kbc!.id, customerId: cb!.id, serviceId: svc!.id },
    ]);
    await tx.insert(schema.contractEntitlements).values([
      { contractId: ka!.id, customerId: ca!.id, name: `Alpha visits ${S}`, quantity: '4', unit: 'visits', period: 'quarterly' },
      { contractId: kbc!.id, customerId: cb!.id, name: `Beta visits ${S}`, quantity: '9', unit: 'visits', period: 'quarterly' },
    ]);
    // Maintenance for both.
    const [pa] = await tx.insert(schema.pmPrograms).values({ customerId: ca!.id, siteId: siteA!.id, contractId: ka!.id, name: `Alpha firewall PM ${S}`, frequency: 'quarterly', startDate: day(-30) }).returning();
    const [pb] = await tx.insert(schema.pmPrograms).values({ customerId: cb!.id, siteId: siteB!.id, contractId: kbc!.id, name: `Beta firewall PM ${S}`, frequency: 'quarterly', startDate: day(-30) }).returning();
    await tx.insert(schema.pmOccurrences).values([
      { programId: pa!.id, customerId: ca!.id, plannedDate: day(10), status: 'planned' },
      { programId: pb!.id, customerId: cb!.id, plannedDate: day(10), status: 'planned' },
    ]);
    await tx.insert(schema.fieldVisits).values({ number: `ISO-FV-${S}`, customerId: cb!.id, siteId: siteB!.id, title: `Beta site visit ${S}`, status: 'scheduled', scheduledStart: new Date(Date.now() + 5 * 86_400_000) });
  });
  admin = await principalFor('admin@msp.local');
  alphaUser = await principalFor(`iso-alpha-${S}@test.local`);

  // Look-alike tickets: two for Alpha, one for Beta with the same wording.
  const make = (ctx: Ctx, customerId: string, title: string) => createTicket(ctx, { type: 'incident', customerId, title, description: `Firewall cluster failover failed at the head office ${S}. VPN users disconnected.`, serviceId: ids.service, siteId: customerId === ids.a ? ids.siteA : ids.siteB });
  await asAdmin(async (ctx) => {
    const a1 = await make(ctx, ids.a, `Firewall failover failed ${S}`);
    const a2 = await make(ctx, ids.a, `Firewall failover failed again ${S}`);
    const b1 = await make(ctx, ids.b, `Firewall failover failed ${S}`);
    ticketIds.push(a1.id, a2.id, b1.id);
    numbers.a1 = a1.number;
    numbers.a2 = a2.number;
    numbers.b1 = b1.number;
    await resolveTicket(ctx, a2.id, { resolutionNotes: 'Re-synced the HA pair.' });
  });

  // Knowledge: internal, Alpha-only, Beta-only, public. Only the last three are published.
  await asAdmin(async (ctx) => {
    const internal = await kb.createArticle(ctx, { title: `Firewall HA runbook ${S}`, summary: 'Internal', body: 'Internal steps', articleType: 'runbook', visibility: 'internal' });
    const forA = await kb.createArticle(ctx, { title: `Firewall VPN guide for Alpha ${S}`, body: 'Alpha profile', visibility: 'customer', customerId: ids.a });
    const forB = await kb.createArticle(ctx, { title: `Firewall VPN guide for Beta ${S}`, body: 'Beta profile', visibility: 'customer', customerId: ids.b });
    const pub = await kb.createArticle(ctx, { title: `Firewall basics for everyone ${S}`, body: 'Public', visibility: 'public', articleType: 'faq' });
    articleIds.push(internal.id, forA.id, forB.id, pub.id);
    for (const id of [internal.id, forA.id, forB.id, pub.id]) await kb.publishArticle(ctx, id);
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.userId, [admin.id, ids.userA]));
    if (articleIds.length) await tx.delete(schema.kbArticles).where(inArray(schema.kbArticles.id, articleIds));
    await tx.delete(schema.kbArticles).where(like(schema.kbArticles.title, `%${S}%`));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.a, ids.b]));
    await tx.delete(schema.users).where(eq(schema.users.id, ids.userA));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('every portal-reachable tool answers for the user’s own organisation only', () => {
  it('offers no MSP-only tools to the portal user', async () => {
    const names = await asAlpha(async (ctx) => availableTools(ctx).map((t) => t.name));
    for (const forbidden of ['list_customers', 'get_customer', 'get_ci', 'ci_history', 'impact_analysis', 'list_assets', 'my_workload', 'problem_candidates', 'engineer_directory', 'out_of_scope_work', 'top_services_by_incidents']) expect(names).not.toContain(forbidden);
  });

  it('search finds Alpha’s ticket and never Beta’s, even with Beta’s exact ticket number', async () => {
    const tool = toolByName('search')!;
    const byWords = (await asAlpha((ctx) => tool.run(ctx, { q: `Firewall failover ${S}`, types: ['ticket', 'kb'], limit: 20 }))) as { hits: { title: string; type: string }[] };
    expect(byWords.hits.some((h) => h.title.includes(numbers.a1))).toBe(true);
    expect(text(byWords)).not.toContain(numbers.b1);
    expect(text(byWords)).not.toContain(BETA);
    const byNumber = (await asAlpha((ctx) => tool.run(ctx, { q: numbers.b1, types: ['ticket'] }))) as { hits: unknown[] };
    expect(byNumber.hits).toEqual([]);
    const articles = (await asAlpha((ctx) => tool.run(ctx, { q: `Firewall VPN guide ${S}`, types: ['kb'], limit: 20 }))) as { hits: { title: string }[] };
    expect(articles.hits.some((h) => h.title.includes('for Alpha'))).toBe(true);
    expect(articles.hits.some((h) => h.title.includes('for Beta'))).toBe(false);
    expect(articles.hits.some((h) => h.title.includes('HA runbook'))).toBe(false);
  });

  it('list_tickets, ticket_stats and similar_tickets ignore a request for Beta', async () => {
    const list = (await asAlpha((ctx) => toolByName('list_tickets')!.run(ctx, { customer: BETA, openOnly: false, q: 'Firewall' }))) as { items: { number: string; customer: string }[] };
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((t) => t.customer === ALPHA)).toBe(true);
    expect(text(list)).not.toContain(numbers.b1);

    const stats = (await asAlpha((ctx) => toolByName('ticket_stats')!.run(ctx, { customer: BETA_CODE }))) as { byType: Record<string, number> };
    const own = await withSystem((tx) => tx.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.customerId, ids.a)));
    expect(stats.byType.incident ?? 0).toBeLessThanOrEqual(own.length);

    const similar = (await asAlpha((ctx) => toolByName('similar_tickets')!.run(ctx, { ticket: numbers.a1 }))) as { items: { number: string; customer: string | null }[] };
    expect(similar.items.some((s) => s.number === numbers.a2)).toBe(true);
    expect(similar.items.every((s) => s.customer === ALPHA)).toBe(true);
    expect(text(similar)).not.toContain(numbers.b1);
  });

  it('get_ticket and ticket_timeline refuse Beta’s ticket by number and by id', async () => {
    for (const ref of [numbers.b1, ticketIds[2]!]) {
      await expect(asAlpha((ctx) => toolByName('get_ticket')!.run(ctx, { ticket: ref }))).rejects.toBeInstanceOf(AppError);
      await expect(asAlpha((ctx) => toolByName('ticket_timeline')!.run(ctx, { ticket: ref }))).rejects.toBeInstanceOf(AppError);
    }
    const mine = (await asAlpha((ctx) => toolByName('get_ticket')!.run(ctx, { ticket: numbers.a1 }))) as { customer: string; link: string };
    expect(mine.customer).toBe(ALPHA);
    expect(mine.link).toBe(`/portal/tickets/${ticketIds[0]}`);
  });

  it('contracts, entitlements, SLA figures and maintenance stay on Alpha when Beta is requested', async () => {
    const contracts = (await asAlpha((ctx) => toolByName('list_contracts')!.run(ctx, { customer: BETA, status: 'active' }))) as { items: { number: string }[] };
    expect(contracts.items.map((c) => c.number)).toEqual([`ISO-A-${S}`]);

    const ents = (await asAlpha((ctx) => toolByName('entitlement_usage')!.run(ctx, { customer: BETA_CODE }))) as { customerId: string; items: { name: string }[] };
    expect(ents.customerId).toBe(ids.a);
    expect(ents.items.map((e) => e.name)).toEqual([`Alpha visits ${S}`]);

    const sla = (await asAlpha((ctx) => toolByName('sla_compliance')!.run(ctx, { customer: BETA, groupBy: 'customer', days: 30 }))) as { groups: { label: string }[] };
    expect(sla.groups.every((g) => g.label === ALPHA)).toBe(true);
    expect(text(sla)).not.toContain(BETA);

    const maint = (await asAlpha((ctx) => toolByName('upcoming_maintenance')!.run(ctx, { customer: BETA, days: 60 }))) as { maintenance: { program: string }[]; visits: { title: string }[] };
    expect(maint.maintenance.map((m) => m.program)).toEqual([`Alpha firewall PM ${S}`]);
    expect(maint.visits).toEqual([]);
  });

  it('knowledge_search returns public and Alpha articles, never Beta’s or internal ones', async () => {
    const res = (await asAlpha((ctx) => toolByName('knowledge_search')!.run(ctx, { q: `Firewall ${S}`, customer: BETA, limit: 10, includeBody: true }))) as { items: { title: string; body?: string }[] };
    const titles = res.items.map((a) => a.title);
    expect(titles.some((t) => t.includes('for Alpha'))).toBe(true);
    expect(titles.some((t) => t.includes('for everyone'))).toBe(true);
    expect(titles.some((t) => t.includes('for Beta'))).toBe(false);
    expect(titles.some((t) => t.includes('HA runbook'))).toBe(false);
    expect(text(res)).not.toContain('Beta profile');
  });

  it('create_ticket as a portal user lands on Alpha even when the model names Beta', async () => {
    const created = (await asAlpha((ctx) => toolByName('create_ticket')!.run(ctx, { customer: BETA, type: 'incident', title: `Raised through the assistant ${S}`, site: `Beta HQ ${S}` }).catch((e: Error) => ({ error: e.message })))) as { id?: string; customer?: string; error?: string };
    // Either the ticket was created for Alpha (Beta's site cannot resolve) or the site lookup failed; never a Beta ticket.
    if (created.id) {
      ticketIds.push(created.id);
      expect(created.customer).toBe(ALPHA);
    } else {
      expect(created.error).toMatch(/site/i);
    }
    const strays = await withSystem((tx) => tx.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.customerId, ids.b)));
    expect(strays.length).toBe(1);
  });
});

describe('tenant fence', () => {
  const fence = { customerId: '11111111-1111-4111-8111-111111111111', customerName: 'Alpha Co', customerCode: 'ALPHA' };
  const other = '22222222-2222-4222-8222-222222222222';

  it('recognises records of another organisation by id, name or code', () => {
    expect(belongsElsewhere({ customerId: other }, fence)).toBe(true);
    expect(belongsElsewhere({ customerId: fence.customerId }, fence)).toBe(false);
    expect(belongsElsewhere({ customer: 'Beta Co' }, fence)).toBe(true);
    expect(belongsElsewhere({ customer: ' alpha co ' }, fence)).toBe(false);
    expect(belongsElsewhere({ customer: 'ALPHA' }, fence)).toBe(false);
    expect(belongsElsewhere({ customer: { id: other, name: 'Beta Co' } }, fence)).toBe(true);
    expect(belongsElsewhere({ customer: { id: fence.customerId, name: 'Alpha Co' } }, fence)).toBe(false);
    expect(belongsElsewhere({ customerName: null, customer: '' }, fence)).toBe(false);
  });

  it('drops foreign rows from lists, nulls foreign nested records and refuses a foreign top-level record', () => {
    const list = fenceToolResult({ total: 3, items: [{ number: 'A-1', customerId: fence.customerId }, { number: 'B-1', customerId: other }, { number: 'B-2', customer: 'Beta Co' }] }, fence);
    expect(list.dropped).toBe(2);
    expect((list.value as { items: { number: string }[] }).items.map((i) => i.number)).toEqual(['A-1']);

    const nested = fenceToolResult({ ticket: 'A-1', customer: 'Alpha Co', linked: { number: 'B-9', customerId: other } }, fence);
    expect(nested.dropped).toBe(1);
    expect((nested.value as { linked: unknown }).linked).toBeNull();

    const top = fenceToolResult({ number: 'B-1', customer: 'Beta Co', title: 'secret' }, fence);
    expect(top.dropped).toBe(1);
    expect(top.value).toEqual({ error: 'forbidden', message: expect.stringContaining('another organisation') });

    const clean = fenceToolResult({ items: [{ a: 1 }, { customer: 'Alpha Co' }], n: 2, s: 'x', nothing: null }, fence);
    expect(clean.dropped).toBe(0);
    expect(clean.value).toEqual({ items: [{ a: 1 }, { customer: 'Alpha Co' }], n: 2, s: 'x', nothing: null });
  });

  it('holds inside executeToolCall even when a tool misbehaves: Beta rows never reach the model and the event is audited', async () => {
    // The service layer scopes every real tool itself (list_tickets adds customer_id = the user's own customer), so a
    // leak is simulated with a throw-away tool that returns rows of both organisations, as a buggy or future tool might.
    const probe: AiTool = {
      name: `iso_probe_${S}`,
      description: 'test probe',
      inputSchema: z.object({}),
      requires: [],
      portal: ['portal:access'],
      action: false,
      run: async () => ({ total: 2, items: [{ number: numbers.a1, customerId: ids.a, customer: ALPHA }, { number: numbers.b1, customerId: ids.b, customer: BETA }], note: { customer: BETA, secret: 'leak' } }),
      summary: () => 'probe',
    };
    ALL_TOOLS.push(probe);
    try {
      const out = await asAlpha((ctx) => ai.executeToolCall(ctx, { id: 'c1', name: probe.name, input: {} }, 0));
      expect(out.isError).toBe(false);
      expect(out.content).toContain(numbers.a1);
      expect(out.content).not.toContain(numbers.b1);
      expect(out.content).not.toContain(BETA);
      expect(out.content).not.toContain('leak');
      expect(out.record.fenced).toBe(2);
      const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.requestId, meta.requestId)));
      expect(audits.some((a) => a.action === 'ai.tenant_fence')).toBe(true);
      // MSP staff are not fenced: they may legitimately see several customers.
      const staff = await asAdmin((ctx) => ai.executeToolCall(ctx, { id: 'c2', name: probe.name, input: {} }, 1));
      expect(staff.content).toContain(numbers.b1);
      expect(staff.record.fenced).toBeUndefined();
    } finally {
      ALL_TOOLS.splice(ALL_TOOLS.indexOf(probe), 1);
    }
  });
});

describe('prompt and conversations', () => {
  it('names the user’s organisation, carries no real customer in the examples, and forbids talking about others', async () => {
    const system = await asAlpha(async (ctx) => {
      const org = await ai.organisationOf(ctx);
      const organisation = org ? { name: org.customerName, code: org.customerCode } : null;
      return buildSystemPrompt({ ctx, tools: availableTools(ctx), customerScopeSummary: describeScope(ctx, organisation), organisation });
    });
    expect(system).toContain(`${ALPHA} (${ALPHA_CODE})`);
    expect(system).toContain(`Every answer is about ${ALPHA} only`);
    expect(system).not.toMatch(/Acme|Apex Retail|ABC Manufacturing|Meridian|Northwind|Priya Sharma/);
    expect(system).toContain('never reuse their names, numbers, dates or figures');
    const staff = await asAdmin(async (ctx) => buildSystemPrompt({ ctx, tools: availableTools(ctx), customerScopeSummary: describeScope(ctx, null) }));
    expect(staff).toContain('all customers (MSP-wide)');
  });

  it('a chat turn that asks about Beta gets a refusal from the tool, and the conversation is held under Alpha', async () => {
    class Probe implements AiProvider {
      readonly name = 'fake';
      readonly model = 'fake-1';
      systems: string[] = [];
      async chat(opts: ChatOptions): Promise<ChatResponse> {
        this.systems.push(opts.system ?? '');
        const last = opts.messages[opts.messages.length - 1]!;
        if (last.role === 'user') return { text: '', toolCalls: [{ id: 't1', name: 'get_ticket', input: { ticket: numbers.b1 } }, { id: 't2', name: 'list_tickets', input: { customer: BETA, openOnly: false } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        const results = opts.messages.filter((m) => m.role === 'tool') as { name: string; content: string; isError?: boolean }[];
        const list = JSON.parse(results.find((r) => r.name === 'list_tickets')!.content) as { items: { number: string; customer: string }[] };
        return { text: `I can only see ${list.items[0]?.customer ?? 'your organisation'}; ${list.items.length} tickets.`, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
    const probe = new Probe();
    ai.setProviderForTests(probe);
    try {
      const res = await asAlpha((ctx) => ai.chat(ctx, { message: `What is open for ${BETA}?` }));
      expect(probe.systems[0]).toContain(ALPHA);
      expect(probe.systems[0]).not.toContain('Acme');
      const [get, list] = res.message.toolCalls;
      expect(get!.name).toBe('get_ticket');
      expect(get!.ok).toBe(false);
      expect(list!.ok).toBe(true);
      expect(res.message.content).toContain(ALPHA);
      expect(res.message.content).not.toContain(BETA);

      // Stored under Alpha: the same user, if ever moved to Beta, cannot continue or list it.
      const [row] = await withSystem((tx) => tx.select({ customerId: schema.aiConversations.customerId }).from(schema.aiConversations).where(eq(schema.aiConversations.id, res.conversationId)));
      expect(row!.customerId).toBe(ids.a);
      const moved: Principal = { ...alphaUser, customerId: ids.b, customerScope: [ids.b] };
      await expect(runAs(moved, meta, (ctx) => ai.getConversation(ctx, res.conversationId))).rejects.toBeInstanceOf(AppError);
      const listed = await runAs(moved, meta, (ctx) => ai.listConversations(ctx));
      expect(listed.items.map((c) => c.id)).not.toContain(res.conversationId);
      const own = await asAlpha((ctx) => ai.listConversations(ctx));
      expect(own.items.map((c) => c.id)).toContain(res.conversationId);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('answer fence: references the conversation never showed are removed, cited ones stay', () => {
    const seen = collectSeen(['{"items":[{"number":"INC-000123","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]}']);
    const clean = fenceAnswer('[INC-000123](/portal/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa) is in progress.', seen);
    expect(clean.removed).toBe(0);
    expect(clean.text).toContain('INC-000123');
    const dirty = fenceAnswer('**2 open**: [INC-000123](/portal/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa) and [INC-009999](/portal/tickets/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb) (also see REQ-007777).', seen);
    expect(dirty.removed).toBe(3);
    expect(dirty.text).toContain('INC-000123');
    expect(dirty.text).not.toContain('INC-009999');
    expect(dirty.text).not.toContain('bbbbbbbb');
    expect(dirty.text).not.toContain('REQ-007777');
    expect(dirty.text).toContain(ANSWER_FENCE_NOTE);
  });

  it('a chat reply that cites a ticket the tools never returned is scrubbed before it is stored', async () => {
    ai.setProviderForTests({
      name: 'fake',
      model: 'x',
      chat: async (opts: ChatOptions) => {
        const last = opts.messages[opts.messages.length - 1]!;
        if (last.role === 'user') return { text: '', toolCalls: [{ id: 't1', name: 'list_tickets', input: { openOnly: false, q: `Firewall failover failed ${S}` } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: `Open for you: [${numbers.a1}](/portal/tickets/${ticketIds[0]}). Also [${numbers.b1}](/portal/tickets/${ticketIds[2]}) for ${BETA}.`, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    try {
      const res = await asAlpha((ctx) => ai.chat(ctx, { message: 'What is open?' }));
      expect(res.message.content).toContain(numbers.a1);
      expect(res.message.content).not.toContain(numbers.b1);
      expect(res.message.content).not.toContain(ticketIds[2]);
      expect(res.message.content).toContain(ANSWER_FENCE_NOTE);
      const stored = await asAlpha((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(stored.messages[1]!.content).not.toContain(numbers.b1);
      const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.requestId, meta.requestId)));
      expect(audits.some((a) => a.action === 'ai.answer_fence')).toBe(true);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('a portal account without an organisation cannot use the assistant', async () => {
    const orphan: Principal = { ...alphaUser, customerId: null, customerScope: [] };
    ai.setProviderForTests({ name: 'fake', model: 'x', chat: async () => ({ text: 'no', toolCalls: [], stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 } }) });
    try {
      await expect(runAs(orphan, meta, (ctx) => ai.chat(ctx, { message: 'hello' }))).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      ai.setProviderForTests(null);
    }
  });
});
