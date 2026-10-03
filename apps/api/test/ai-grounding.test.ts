/**
 * Grounded assistant (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/ai-grounding.test.ts
 *
 * The complaint being fixed: "I ask how many tickets and get a different answer
 * every time". The guarantees under test:
 *   1. Numbers are computed by the server over the same predicates as the ticket
 *      list (query_tickets), with a plain-language definition of what was counted.
 *   2. The same question yields the same tool call and the same stored answer.
 *   3. A reply that does not state the computed figure gets the facts put first.
 *   4. Actions are propose-then-commit: nothing runs until the user confirms,
 *      then it runs exactly once; a "no" or any other message drops it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, and } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, resolveTicket } from '../src/modules/tickets/service';
import { systemText, type AiProvider, type ChatOptions, type ChatResponse } from '../src/lib/ai';
import { availableTools, toolByName, ALL_TOOLS } from '../src/modules/ai/tools';
import { runTicketQuery, type TicketQueryResult } from '../src/modules/ai/query';
import { groundAnswer, factsOf } from '../src/modules/ai/ground';
import * as ai from '../src/modules/ai/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-ai-ground-${S}`, ip: '127.0.0.1' };
const ALPHA = `Grounded Alpha ${S}`;
const BETA = `Grounded Beta ${S}`;
let admin: Principal;
let portalUser: Principal;
const ids = { a: '', b: '', siteA: '', service: '', userA: '', p1: '', p3: '' };
const ticketIds: string[] = [];
const numbers: Record<string, string> = {};

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalUser, meta, fn);

async function principalFor(email: string) {
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1));
  invalidatePrincipal(u!.id);
  const p = await loadPrincipal(u!.id);
  if (!p) throw new Error(`principal not loaded for ${email}`);
  return p;
}

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

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [ca] = await tx.insert(schema.customers).values({ code: `GRA${S.toUpperCase()}`, name: ALPHA }).returning();
    const [cb] = await tx.insert(schema.customers).values({ code: `GRB${S.toUpperCase()}`, name: BETA }).returning();
    ids.a = ca!.id;
    ids.b = cb!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: ca!.id, code: 'HQ', name: `Alpha HQ ${S}`, isPrimary: true }).returning();
    ids.siteA = site!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `gr_svc_${S}`, name: `Email Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const [u] = await tx.insert(schema.users).values({ email: `gr-portal-${S}@test.local`, name: 'Grounded Portal User', userType: 'customer', customerId: ca!.id, status: 'active' }).returning({ id: schema.users.id });
    ids.userA = u!.id;
    await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: role!.id, customerId: ca!.id });
    const prios = await tx.select({ id: schema.configOptions.id, key: schema.configOptions.key }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), inArray(schema.configOptions.key, ['p1', 'p3'])));
    ids.p1 = prios.find((p) => p.key === 'p1')!.id;
    ids.p3 = prios.find((p) => p.key === 'p3')!.id;
  });
  admin = await principalFor('admin@msp.local');
  portalUser = await principalFor(`gr-portal-${S}@test.local`);
  // Alpha: 3 open incidents (one P1, two P3), 1 open request, 1 resolved incident. Beta: 2 open incidents.
  await asAdmin(async (ctx) => {
    const mk = (customerId: string, type: 'incident' | 'request', title: string, priorityId: string | null) => createTicket(ctx, { type, customerId, title, description: `Grounding fixture ${S}`, serviceId: ids.service, siteId: customerId === ids.a ? ids.siteA : null, priorityId });
    const a1 = await mk(ids.a, 'incident', `Mailbox full ${S}`, ids.p1);
    const a2 = await mk(ids.a, 'incident', `Mail delayed ${S}`, ids.p3);
    const a3 = await mk(ids.a, 'incident', `Spam filter misfire ${S}`, ids.p3);
    const a4 = await mk(ids.a, 'request', `New mailbox for a starter ${S}`, ids.p3);
    const a5 = await mk(ids.a, 'incident', `Old outage ${S}`, ids.p3);
    const b1 = await mk(ids.b, 'incident', `Beta mail down ${S}`, ids.p1);
    const b2 = await mk(ids.b, 'incident', `Beta mail slow ${S}`, ids.p3);
    ticketIds.push(a1.id, a2.id, a3.id, a4.id, a5.id, b1.id, b2.id);
    numbers.a1 = a1.number;
    await resolveTicket(ctx, a5.id, { resolutionNotes: 'Fixed.' });
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.userId, [admin.id, ids.userA]));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.a, ids.b]));
    await tx.delete(schema.users).where(eq(schema.users.id, ids.userA));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('query_tickets: one exact figure with its definition', () => {
  it('counts open tickets by default, all tickets on request, and the figures agree with the list', async () => {
    const open = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'count', customer: ALPHA }));
    expect(open.total).toBe(4);
    expect(open.definition).toBe(`open tickets (new, in progress or pending) for ${ALPHA}`);
    expect(open.facts).toEqual([`4 open tickets (new, in progress or pending) for ${ALPHA}`]);

    const all = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'count', status: 'all', customer: ALPHA }));
    expect(all.total).toBe(5);
    expect(all.facts[0]).toBe(`5 tickets of any status for ${ALPHA}`);

    const resolved = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'count', status: 'resolved', customer: ALPHA }));
    expect(resolved.total).toBe(1);

    const incidents = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'count', type: 'incident', priority: 'p3', customer: ALPHA }));
    expect(incidents.total).toBe(2);
    expect(incidents.definition).toContain('incidents');
    expect(incidents.definition).toContain('with priority P3');

    const list = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'list', customer: ALPHA, limit: 2 }));
    expect(list.total).toBe(4);
    expect(list.showing).toBe(2);
    expect(list.items!.length).toBe(2);
    expect(list.facts[0]).toBe(`4 open tickets (new, in progress or pending) for ${ALPHA} (showing the first 2)`);
  });

  it('breaks down by priority and by type with groups that add up to the total', async () => {
    const byPriority = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'breakdown', groupBy: 'priority', customer: ALPHA }));
    expect(byPriority.total).toBe(4);
    expect(byPriority.groups!.reduce((s, g) => s + g.count, 0)).toBe(4);
    expect(byPriority.groups!.map((g) => [g.label, g.count])).toEqual([
      ['P1 - Critical', 1],
      ['P3 - Medium', 3],
    ]);
    expect(byPriority.facts[1]).toBe('By priority: P1 - Critical 1, P3 - Medium 3');
    const byType = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'breakdown', groupBy: 'type', customer: ALPHA }));
    expect(Object.fromEntries(byType.groups!.map((g) => [g.label, g.count]))).toEqual({ incident: 3, request: 1 });
    const bySla = await asAdmin((ctx) => runTicketQuery(ctx, { mode: 'breakdown', groupBy: 'slaState', customer: ALPHA }));
    expect(bySla.groups!.reduce((s, g) => s + g.count, 0)).toBe(4);
  });

  it('pins portal users to their organisation whatever they ask for', async () => {
    const r = await asPortal((ctx) => runTicketQuery(ctx, { mode: 'count', customer: BETA }));
    expect(r.total).toBe(4);
    expect(r.definition).toContain(ALPHA);
    expect(r.definition).not.toContain(BETA);
  });

  it('is the only ticket tool offered to the model; the superseded ones stay callable for stored conversations', async () => {
    const offered = await asAdmin(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(offered).toContain('query_tickets');
    expect(offered).not.toContain('list_tickets');
    expect(offered).not.toContain('ticket_stats');
    expect(toolByName('list_tickets')!.hidden).toBe(true);
    const legacy = await asAdmin((ctx) => ai.executeToolCall(ctx, { id: 'x', name: 'list_tickets', input: { customer: ALPHA, openOnly: true } }, 0));
    expect(legacy.isError).toBe(false);
    expect(ALL_TOOLS.filter((t) => !t.hidden && t.name.includes('ticket') && !t.action).map((t) => t.name)).not.toContain('ticket_stats');
  });
});

describe('the chat loop is deterministic and grounded', () => {
  it('asks the provider at temperature 0 and stores the same answer for the same question, three times over', async () => {
    const provider = scripted([{ name: 'query_tickets', input: { mode: 'count', customer: ALPHA } }], (r) => {
      const q = JSON.parse(r.query_tickets!) as TicketQueryResult;
      return `There are **${q.total}** ${q.definition}.`;
    });
    ai.setProviderForTests(provider);
    try {
      const answers: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await asAdmin((ctx) => ai.chat(ctx, { message: `How many tickets does ${ALPHA} have?` }));
        answers.push(res.message.content);
        expect(res.message.toolCalls.map((t) => t.summary)).toEqual([`Counted 4 open tickets (new, in progress or pending) for ${ALPHA}`]);
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toBe(`There are **4** open tickets (new, in progress or pending) for ${ALPHA}.`);
      expect(provider.seen.every((o) => o.temperature === 0)).toBe(true);
      expect(provider.seen[0]!.tools?.some((t) => t.name === 'query_tickets')).toBe(true);
      expect(provider.seen[0]!.tools?.some((t) => t.name === 'list_tickets')).toBe(false);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('puts the computed figure first when the model forgets to state it, and leaves a correct reply alone', async () => {
    expect(factsOf(JSON.stringify({ total: 4, facts: ['4 open tickets for X'] }))).toEqual(['4 open tickets for X']);
    expect(factsOf('not json')).toEqual([]);
    expect(groundAnswer('You have 4 open tickets.', ['4 open tickets (new, in progress or pending) for X'])).toEqual({ text: 'You have 4 open tickets.', prepended: false });
    expect(groundAnswer('Quite a few are open.', ['4 open tickets (new, in progress or pending) for X']).text).toBe('**4** open tickets (new, in progress or pending) for X\n\nQuite a few are open.');
    expect(groundAnswer('There are 1,234 of them', ['1,234 tickets of any status']).prepended).toBe(false);
    expect(groundAnswer('', ['0 open tickets for X']).text).toBe('**0** open tickets for X');
    expect(groundAnswer('No facts here', []).prepended).toBe(false);

    const vague = scripted([{ name: 'query_tickets', input: { mode: 'count', customer: ALPHA } }], () => 'A handful of tickets are open right now.');
    ai.setProviderForTests(vague);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `How many open tickets for ${ALPHA}?` }));
      expect(res.message.content.startsWith(`**4** open tickets (new, in progress or pending) for ${ALPHA}`)).toBe(true);
      expect(res.message.content).toContain('A handful of tickets are open right now.');
      const stored = await asAdmin((ctx) => ai.getConversation(ctx, res.conversationId));
      expect(stored.messages[1]!.content.startsWith('**4**')).toBe(true);
    } finally {
      ai.setProviderForTests(null);
    }
  });
});

describe('actions are propose-then-commit', () => {
  const countComments = async (ticketId: string) => (await withSystem((tx) => tx.select({ id: schema.ticketComments.id }).from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketId)))).length;

  it('proposes with a resolved preview, runs exactly once on "yes", and ignores a second "yes"', async () => {
    const before = await countComments(ticketIds[0]!);
    const propose = scripted([{ name: 'add_comment', input: { ticket: numbers.a1, body: `Engineer dispatched ${S}` } }], (r) => {
      const t = JSON.parse(r.add_comment!) as { status: string; preview: string };
      return `${t.preview}. Shall I proceed?`;
    });
    ai.setProviderForTests(propose);
    let conversationId = '';
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `Add a comment to ${numbers.a1}: engineer dispatched` }));
      conversationId = res.conversationId;
      expect(res.pendingAction).toMatchObject({ tool: 'add_comment' });
      expect(res.pendingAction!.preview).toContain(numbers.a1);
      expect(res.pendingAction!.preview).toContain(`Engineer dispatched ${S}`);
      expect(res.message.toolCalls[0]).toMatchObject({ name: 'add_comment', ok: true, proposed: true, action: true });
      expect(res.message.content).toContain('Shall I proceed?');
      expect(await countComments(ticketIds[0]!)).toBe(before);
      const loaded = await asAdmin((ctx) => ai.getConversation(ctx, conversationId));
      expect(loaded.pendingAction?.id).toBe(res.pendingAction!.id);
      expect(propose.seen.length).toBe(2);

      // Confirmation is handled by the platform: the model is not consulted, the action runs once.
      const yes = await asAdmin((ctx) => ai.chat(ctx, { conversationId, message: 'Yes, proceed.' }));
      expect(propose.seen.length).toBe(2);
      expect(yes.pendingAction).toBeNull();
      expect(yes.message.content).toMatch(/^Done: Added comment to /);
      expect(yes.message.content).toContain(`/tickets/${ticketIds[0]}`);
      expect(yes.message.toolCalls[0]).toMatchObject({ name: 'add_comment', ok: true, action: true });
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
      const [c] = await withSystem((tx) => tx.select({ source: schema.ticketComments.source, body: schema.ticketComments.body }).from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketIds[0]!)).orderBy(schema.ticketComments.createdAt).limit(10));
      expect(c!.source).toBe('ai');

      // A second "yes" has nothing to run: the model answers normally and nothing is duplicated.
      const again = await asAdmin((ctx) => ai.chat(ctx, { conversationId, message: 'yes' }));
      expect(propose.seen.length).toBe(4);
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
      expect(again.pendingAction).toMatchObject({ tool: 'add_comment' });
      // (the scripted model proposed again; drop it so the next test starts clean)
      await asAdmin((ctx) => ai.chat(ctx, { conversationId, message: 'No, do not do that.' }));
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('drops the proposal on "no", and on any other message cancels it and tells the model so', async () => {
    const propose = scripted([{ name: 'create_ticket', input: { customer: ALPHA, type: 'incident', title: `Printer on fire ${S}`, priority: 'p2' } }], (r) => {
      const t = JSON.parse(r.create_ticket!) as { preview: string };
      return `${t.preview}. Shall I proceed?`;
    });
    ai.setProviderForTests(propose);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: `Raise a P2 for ${ALPHA}: printer on fire` }));
      expect(res.pendingAction!.preview).toBe(`Create an incident for ${ALPHA} titled "Printer on fire ${S}" with priority P2 - High`);
      const strays = async () => (await withSystem((tx) => tx.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.customerId, ids.a), eq(schema.tickets.title, `Printer on fire ${S}`))))).length;
      expect(await strays()).toBe(0);

      const no = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'No, do not do that.' }));
      expect(no.message.content).toBe('OK, I have not done that.');
      expect(no.pendingAction).toBeNull();
      expect(await strays()).toBe(0);
      expect(propose.seen.length).toBe(2);

      // Propose again, then answer with something else: the proposal is cancelled and the model is told.
      const res2 = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: `Raise a P2 for ${ALPHA}: printer on fire` }));
      expect(res2.pendingAction).not.toBeNull();
      const other = await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'Actually, what is the SLA on P2?' }));
      expect(propose.seen[propose.seen.length - 2]!.system).toContain('was not confirmed and is now cancelled');
      expect(await strays()).toBe(0);
      // the scripted model proposes yet again on that turn; that is fine, it is held, not run
      expect(other.pendingAction).not.toBeNull();
      await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'cancel' }));
      expect(await strays()).toBe(0);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('holds only one action per turn and refuses the preview when the record does not exist', async () => {
    const two = scripted(
      [
        { name: 'add_comment', input: { ticket: numbers.a1, body: 'first' } },
        { name: 'assign_ticket', input: { ticket: numbers.a1, engineer: 'me' } },
      ],
      () => 'Two things proposed. Shall I proceed?',
    );
    ai.setProviderForTests(two);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'comment and assign' }));
      expect(res.message.toolCalls.map((t) => [t.name, t.ok, t.error ?? null])).toEqual([
        ['add_comment', true, null],
        ['assign_ticket', false, 'one_action_at_a_time'],
      ]);
      expect(res.pendingAction!.tool).toBe('add_comment');
      await asAdmin((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'no' }));
    } finally {
      ai.setProviderForTests(null);
    }
    const bad = scripted([{ name: 'add_comment', input: { ticket: 'INC-999999', body: 'x' } }], () => 'Hmm.');
    ai.setProviderForTests(bad);
    try {
      const res = await asAdmin((ctx) => ai.chat(ctx, { message: 'comment on a ticket that does not exist' }));
      expect(res.pendingAction).toBeNull();
      expect(res.message.toolCalls[0]!.ok).toBe(false);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('a portal user can confirm a comment through the same flow', async () => {
    const before = await countComments(ticketIds[0]!);
    const propose = scripted([{ name: 'add_comment', input: { ticket: numbers.a1, body: `Customer update ${S}` } }], () => 'Shall I proceed?');
    ai.setProviderForTests(propose);
    try {
      const res = await asPortal((ctx) => ai.chat(ctx, { message: `comment on ${numbers.a1}` }));
      expect(res.pendingAction!.preview).toContain('visible to the customer');
      const yes = await asPortal((ctx) => ai.chat(ctx, { conversationId: res.conversationId, message: 'ok' }));
      expect(yes.message.content).toContain(`/portal/tickets/${ticketIds[0]}`);
      expect(await countComments(ticketIds[0]!)).toBe(before + 1);
    } finally {
      ai.setProviderForTests(null);
    }
  });
});
