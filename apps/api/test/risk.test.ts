/**
 * SLA breach risk and customer sentiment: the pure scorer, the 5-minute job
 * that writes the forecast on open tickets (and clears it when the clocks are
 * done), the sentiment job after a customer comment (lexicon without a
 * provider, the model with one), the notification to the assignee once per
 * six hours, the feature switch, and the customer-facing shapes that never
 * carry either signal. Run with the dev environment sourced:
 * npx vitest run test/risk.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, getTicket, cancelTicket } from '../src/modules/tickets/service';
import { listTickets, ticketStats } from '../src/modules/tickets/list';
import { addComment } from '../src/modules/tickets/activity';
import { scoreTicket, levelOf, scoreOpenTickets } from '../src/modules/sla/risk';
import { lexiconSentiment, analyseComment, sweepUnlabelled } from '../src/modules/ai/sentiment';
import { runTicketQuery } from '../src/modules/ai/query';
import * as ai from '../src/modules/ai/service';
import type { AiProvider, ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-risk-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let portal: Principal;
const ids = { customer: '', site: '', contract: '', engineer: '', portalUser: '', p1: '', p3: '' };
const created: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, meta, fn);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value, description: 'test' }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value } }));
const ticketRow = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1))[0]!);
const activities = (id: string, type: string) => withSystem((tx) => tx.select().from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, id), eq(schema.ticketActivities.activityType, type))).orderBy(desc(schema.ticketActivities.createdAt)));
const inAppFor = (event: string, userId: string, ticketId: string) => withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.event, event), eq(schema.notifications.userId, userId), eq(schema.notifications.entityId, ticketId))));
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
const d = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const newTicket = (title: string, extra: Record<string, unknown> = {}) =>
  asAdmin(async (ctx) => {
    const t = await createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title, description: 'Users cannot reach the file server.', priorityId: ids.p1, ...extra } as never);
    created.push(t.id);
    return t;
  });

/** Moves every open clock of the ticket so that `pct` percent of its target is consumed (the P1 clocks are 24x7, so wall time is working time). */
const consume = (ticketId: string, pct: number) =>
  withSystem((tx) =>
    tx.execute(sql`UPDATE ticket_slas SET started_at = now() - (target_minutes * ${pct} / 100.0) * interval '1 minute', due_at = now() + (target_minutes * (100 - ${pct}) / 100.0) * interval '1 minute', paused_minutes = 0 WHERE ticket_id = ${ticketId}::uuid AND state IN ('running', 'paused')`),
  );

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `RK${S.toUpperCase()}`, name: `Risk Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = c!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: c!.id, number: `RSK-${S}`, name: `Contract ${S}`, status: 'active', startDate: d(-10), endDate: d(355), slaPolicyId: policy?.id ?? null }).returning();
    ids.contract = contract!.id;
    const [eng] = await tx.insert(schema.users).values({ email: `rk-eng-${S}@example.test`, name: 'Risk Engineer', userType: 'msp', status: 'active' }).returning();
    ids.engineer = eng!.id;
    await tx.insert(schema.userRoles).values({ userId: eng!.id, roleId: await roleId(tx, 'engineer') });
    const [pu] = await tx.insert(schema.users).values({ email: `rk-portal-${S}@example.test`, name: 'Risk Portal User', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    ids.portalUser = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id });
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  // Principals are resolved outside the seeding transaction (loadPrincipal reads through the shared pool).
  portal = (await loadPrincipal(ids.portalUser))!;
  await setSetting('ai.disabled_features', []);
  ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    if (created.length) {
      await tx.delete(schema.ticketSlas).where(inArray(schema.ticketSlas.ticketId, created));
      await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    }
    await tx.delete(schema.contracts).where(eq(schema.contracts.id, ids.contract));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.engineer, ids.portalUser]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await closeDb();
});

describe('scoreTicket (pure)', () => {
  const base = { pctConsumed: 5, remainingMinutes: 900, elapsedMinutes: 48, medianMinutes: null, breached: false, paused: false, unassigned: false, pendingCustomer: false, escalationLevel: 0, reopenCount: 0 };
  it('a fresh, owned ticket with no history is low', () => {
    const r = scoreTicket(base);
    expect(r.level).toBe('low');
    expect(r.score).toBeLessThan(40);
    expect(r.reason).toContain('5% of the target used');
  });
  it('a breached clock is high at 100', () => {
    expect(scoreTicket({ ...base, breached: true })).toEqual({ level: 'high', score: 100, reason: 'SLA already breached' });
  });
  it('most of the clock gone with similar tickets needing more than what is left is high', () => {
    const r = scoreTicket({ ...base, pctConsumed: 80, remainingMinutes: 60, elapsedMinutes: 240, medianMinutes: 600 });
    expect(r.level).toBe('high');
    expect(r.reason).toContain('similar tickets take 10h, 1h left');
  });
  it('the forecast calms a mid-clock ticket when similar ones finish well inside the target', () => {
    const calm = scoreTicket({ ...base, pctConsumed: 45, remainingMinutes: 500, elapsedMinutes: 400, medianMinutes: 450 });
    const plain = scoreTicket({ ...base, pctConsumed: 45, remainingMinutes: 500, elapsedMinutes: 400 });
    expect(calm.score).toBeLessThan(plain.score);
    expect(calm.level).toBe('low');
  });
  it('no owner adds to the score; waiting on the customer takes from it', () => {
    const owned = scoreTicket({ ...base, pctConsumed: 50 });
    const unowned = scoreTicket({ ...base, pctConsumed: 50, unassigned: true });
    const waiting = scoreTicket({ ...base, pctConsumed: 50, pendingCustomer: true });
    expect(unowned.score).toBe(owned.score + 15);
    expect(unowned.reason).toContain('unassigned');
    expect(waiting.score).toBe(owned.score - 25);
    expect(waiting.reason).toContain('waiting on the customer');
  });
  it('a paused clock never scores above medium', () => {
    const r = scoreTicket({ ...base, pctConsumed: 90, remainingMinutes: 30, elapsedMinutes: 400, medianMinutes: 2000, unassigned: true, paused: true });
    expect(r.score).toBeLessThanOrEqual(55);
    expect(r.level).toBe('medium');
    expect(r.reason).toContain('clock paused');
  });
  it('levels split at 40 and 70', () => {
    expect(levelOf(39)).toBe('low');
    expect(levelOf(40)).toBe('medium');
    expect(levelOf(69)).toBe('medium');
    expect(levelOf(70)).toBe('high');
  });
});

describe('scoreOpenTickets (job)', () => {
  let hot = '';
  let calm = '';
  it('writes high on an unowned ticket with most of its clock gone and logs the rise once', async () => {
    const t = await newTicket(`Hot ticket ${S}`);
    hot = t.id;
    calm = (await newTicket(`Calm ticket ${S}`, { assigneeId: ids.engineer })).id;
    // No owner, whatever an assignment rule may have done on creation.
    await withSystem((tx) => tx.update(schema.tickets).set({ assigneeId: null }).where(eq(schema.tickets.id, hot)));
    await consume(hot, 85);
    const before = await ticketRow(hot);
    const run = await scoreOpenTickets();
    expect(run.scored).toBeGreaterThanOrEqual(2);
    const row = await ticketRow(hot);
    expect(row.breachRisk).toBe('high');
    expect(row.breachRiskScore).toBeGreaterThanOrEqual(70);
    expect(row.breachRiskReason).toContain('unassigned');
    expect(row.breachRiskAt).toBeTruthy();
    // The flag is a system signal: it must not make the ticket look worked on.
    expect(row.lastActivityAt.getTime()).toBe(before.lastActivityAt.getTime());
    const acts = await activities(hot, 'sla');
    expect(acts.some((a) => a.summary.startsWith('Breach risk high:'))).toBe(true);
    expect(acts.find((a) => a.summary.startsWith('Breach risk high:'))!.customerVisible).toBe(false);
    const calmRow = await ticketRow(calm);
    expect(calmRow.breachRisk).toBe('low');
  });
  it('is idempotent: a second run with nothing moved rewrites nothing and logs nothing more', async () => {
    const before = await ticketRow(hot);
    await scoreOpenTickets();
    const after = await ticketRow(hot);
    expect(after.breachRiskAt!.getTime()).toBe(before.breachRiskAt!.getTime());
    expect((await activities(hot, 'sla')).filter((a) => a.summary.startsWith('Breach risk high:'))).toHaveLength(1);
  });
  it('shows the forecast to staff (detail, list, filter, stats, Grady) and never to the customer', async () => {
    const detail = await asAdmin((ctx) => getTicket(ctx, hot));
    expect(detail.breachRisk?.level).toBe('high');
    expect(detail.breachRisk?.reason).toContain('unassigned');
    expect('breachRiskScore' in detail).toBe(false);
    const list = await asAdmin((ctx) => listTickets(ctx, { page: 1, pageSize: 50, order: 'desc', customerId: ids.customer, breachRisk: 'high' } as never));
    expect(list.items.map((i) => i.id)).toContain(hot);
    expect(list.items.map((i) => i.id)).not.toContain(calm);
    expect(list.items.find((i) => i.id === hot)!.breachRisk?.score).toBeGreaterThanOrEqual(70);
    const stats = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customer }));
    expect(stats.highRisk).toBeGreaterThanOrEqual(1);
    const grady = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'list', customer: ids.customer, breachRisk: 'high', limit: 10 } as never));
    expect(grady.facts.join('\n')).toContain('at high risk of an SLA breach');
    expect((grady.items as { number: string; breachRisk: { level: string } | null }[]).find((i) => i.number === detail.number)?.breachRisk?.level).toBe('high');

    const asCustomer = await asPortal((ctx) => getTicket(ctx, hot));
    expect(asCustomer.breachRisk).toBeNull();
    expect('breachRiskScore' in asCustomer).toBe(false);
    expect('breachRiskReason' in asCustomer).toBe(false);
    const customerList = await asPortal((ctx) => listTickets(ctx, { page: 1, pageSize: 50, order: 'desc', breachRisk: 'high' } as never));
    for (const i of customerList.items) expect(i.breachRisk).toBeNull();
  });
  it('clears the forecast once the clocks are done', async () => {
    await asAdmin((ctx) => cancelTicket(ctx, hot, { comment: 'raised in error' } as never));
    const run = await scoreOpenTickets();
    expect(run.cleared).toBeGreaterThanOrEqual(1);
    const row = await ticketRow(hot);
    expect(row.breachRisk).toBeNull();
    expect(row.breachRiskScore).toBeNull();
  });
});

describe('lexiconSentiment (pure)', () => {
  it('reads anger, unhappiness, calm and thanks', () => {
    expect(lexiconSentiment('This is UNACCEPTABLE!!! Third time this week and nobody responds.').sentiment).toBe('angry');
    expect(lexiconSentiment('Still not working after the restart, quite disappointing.').sentiment).toBe('negative');
    expect(lexiconSentiment('Please find the logs attached.').sentiment).toBe('neutral');
    expect(lexiconSentiment('Thanks, that fixed it. Great work!').sentiment).toBe('positive');
  });
  it('explains its verdict', () => {
    const r = lexiconSentiment('This is UNACCEPTABLE!!! Third time this week and nobody responds.');
    expect(r.score).toBeLessThan(-50);
    expect(r.reason).toMatch(/strong word/);
  });
});

describe('analyseComment (job)', () => {
  let ticketId = '';
  let ticketNumber = '';
  const customerComment = (body: string) => asPortal(async (ctx) => (await addComment(ctx, ticketId, { kind: 'comment', body })).id);
  const latestComment = () => withSystem(async (tx) => (await tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketId)).orderBy(desc(schema.ticketComments.createdAt)).limit(1))[0]!);

  it('labels an angry customer comment, flags the ticket and tells the assignee', async () => {
    const t = await newTicket(`Mood ticket ${S}`, { priorityId: ids.p3, assigneeId: ids.engineer });
    ticketId = t.id;
    ticketNumber = t.number;
    const commentId = await customerComment('This is UNACCEPTABLE!!! Third time this week and nobody responds. Escalate this now.');
    const out = await analyseComment(commentId);
    expect(out.sentiment).toBe('angry');
    expect(out.aiGenerated).toBe(false);
    expect(out.notified).toBe(true);
    const c = await latestComment();
    expect(c.sentiment).toBe('angry');
    expect(c.sentimentScore).toBeLessThan(-50);
    const row = await ticketRow(ticketId);
    expect(row.lastSentiment).toBe('angry');
    expect(row.lastSentimentAt).toBeTruthy();
    const acts = await activities(ticketId, 'sentiment');
    expect(acts).toHaveLength(1);
    expect(acts[0]!.summary).toContain('The customer sounds angry');
    expect(acts[0]!.customerVisible).toBe(false);
    const inApp = await inAppFor('ticket.sentiment_negative', ids.engineer, ticketId);
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.title).toContain(ticketNumber);
    expect(inApp[0]!.title).toContain('angry');
  });
  it('is idempotent and reminds at most once per six hours', async () => {
    const c = await latestComment();
    expect((await analyseComment(c.id)).skipped).toBe('already labelled');
    const second = await customerComment('Still broken. Very disappointed with the delay.');
    const out = await analyseComment(second);
    expect(out.sentiment).toBe('negative');
    expect(out.notified).toBe(false);
    expect(await inAppFor('ticket.sentiment_negative', ids.engineer, ticketId)).toHaveLength(1);
    expect(await activities(ticketId, 'sentiment')).toHaveLength(2);
    expect((await ticketRow(ticketId)).lastSentiment).toBe('negative');
  });
  it('shows the mood to staff and filters by it, never to the customer', async () => {
    const detail = await asAdmin((ctx) => getTicket(ctx, ticketId));
    expect(detail.lastSentiment?.sentiment).toBe('negative');
    const list = await asAdmin((ctx) => listTickets(ctx, { page: 1, pageSize: 50, order: 'desc', customerId: ids.customer, sentiment: 'unhappy' } as never));
    expect(list.items.map((i) => i.id)).toEqual([ticketId]);
    const stats = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customer }));
    expect(stats.unhappy).toBe(1);
    const grady = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'count', customer: ids.customer, sentiment: 'unhappy' } as never));
    expect(grady.facts.join('\n')).toContain('1 open tickets (new, in progress or pending) for');
    expect(grady.facts.join('\n')).toContain('sounded unhappy');
    const asCustomer = await asPortal((ctx) => getTicket(ctx, ticketId));
    expect(asCustomer.lastSentiment).toBeNull();
    expect('lastSentimentAt' in asCustomer).toBe(false);
    const customerList = await asPortal((ctx) => listTickets(ctx, { page: 1, pageSize: 50, order: 'desc', sentiment: 'unhappy' } as never));
    expect(customerList.items.length).toBeGreaterThanOrEqual(1);
    for (const i of customerList.items) expect(i.lastSentiment).toBeNull();
  });
  it('a thank-you is labelled positive with no flag or activity', async () => {
    const id = await customerComment('Thanks, that fixed it. Great work!');
    const out = await analyseComment(id);
    expect(out.sentiment).toBe('positive');
    expect(out.notified).toBe(false);
    expect((await ticketRow(ticketId)).lastSentiment).toBe('positive');
    expect(await activities(ticketId, 'sentiment')).toHaveLength(2);
  });
  it('skips staff comments and marks them in the sweep', async () => {
    const staffId = await asAdmin(async (ctx) => (await addComment(ctx, ticketId, { kind: 'comment', body: 'This is unacceptable on our side too; we are on it.' })).id);
    expect((await analyseComment(staffId)).skipped).toBe('written by staff');
    await sweepUnlabelled(100);
    const [row] = await withSystem((tx) => tx.select({ sentiment: schema.ticketComments.sentiment }).from(schema.ticketComments).where(eq(schema.ticketComments.id, staffId)));
    expect(row!.sentiment).toBe('n/a');
    expect((await ticketRow(ticketId)).lastSentiment).toBe('positive');
  });
  it('uses the model when one answers and keeps the lexicon as the fallback', async () => {
    const model: AiProvider = { name: 'fake', model: 'fake-1', chat: async () => json({ sentiment: 'negative', score: -35, reason: 'Polite but clearly frustrated' }) };
    ai.setProviderForTests(model);
    try {
      const id = await customerComment('Could someone please look at this today?');
      const out = await analyseComment(id);
      expect(out.sentiment).toBe('negative');
      expect(out.aiGenerated).toBe(true);
      expect(out.score).toBe(-35);
      const acts = await activities(ticketId, 'sentiment');
      expect(acts[0]!.data).toMatchObject({ aiGenerated: true, reason: 'Polite but clearly frustrated' });
    } finally {
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
    const broken: AiProvider = { name: 'fake', model: 'fake-1', chat: async () => ({ text: 'not json at all', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }) };
    ai.setProviderForTests(broken);
    try {
      const id = await customerComment('Thanks, all good now.');
      const out = await analyseComment(id);
      expect(out.sentiment).toBe('positive');
      expect(out.aiGenerated).toBe(false);
    } finally {
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
  });
  it('respects the feature switch', async () => {
    await setSetting('ai.disabled_features', ['sentiment']);
    try {
      const id = await customerComment('Why is this still open? Terrible.');
      expect((await analyseComment(id)).skipped).toBe('sentiment is switched off');
      expect((await latestComment()).sentiment).toBeNull();
    } finally {
      await setSetting('ai.disabled_features', []);
    }
  });
});
