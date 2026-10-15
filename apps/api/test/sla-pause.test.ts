/**
 * The clock rule (DB-backed): a wait outside the provider's control stops the resolution
 * and restoration clocks and nothing else; the response and acknowledgement clocks are
 * governed by the first answer and keep running (and breach) through any wait; an
 * internal hold stops nothing; a wait-to-wait move pauses or resumes as the party
 * changes, including an approval that moves from an internal step to the customer;
 * reopening into a wait and starting in a wait obey the same rule; a policy's own pause
 * statuses still pause. Run with the dev environment sourced: npx vitest run test/sla-pause.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { config } from '../src/config';
import { createTicket, changeStatus, resolveTicket, reopenTicket } from '../src/modules/tickets/service';
import { requestApproval, decide } from '../src/modules/tickets/approvals';
import { applySlas, markResponded, SYSTEM_ACTOR } from '../src/modules/sla/engine';
import { slaTick } from '../src/jobs/processors/sla';
import { withPolicyPause, withSetting } from './_settings';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-sla-pause-${S}` };
const ids = { customer: '', site: '', service: '', contract: '', adminUser: '', portalAdmin: '', workflow: '', customerWorkflow: '', policy: '', p1: '' };
const st: Record<string, string> = {};
let admin: Principal;
let portalAdmin: Principal;
const tickets: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortalAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalAdmin, meta, fn);

async function optionId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`status ${key} missing (seed not applied?)`);
  return row.id;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing`);
  return row.id;
}
const slas = (id: string) => withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, id)));
const stateOf = async (id: string) => Object.fromEntries((await slas(id)).map((r) => [r.metric, r.state]));
/** The clocks the default policy pauses: read from its `pause_metrics` (the shipped rule seeded as the column default), never a constant here. */
let PAUSABLE: string[] = [];
let FIRST_ANSWER: string[] = [];
const expectPaused = async (id: string, why: string) => {
  const s = await stateOf(id);
  for (const m of PAUSABLE) if (s[m]) expect(s[m], `${why}: ${m}`).toBe('paused');
  for (const m of FIRST_ANSWER) if (s[m]) expect(s[m], `${why}: ${m}`).not.toBe('paused');
};
const expectRunning = async (id: string, why: string) => {
  const s = await stateOf(id);
  for (const m of Object.keys(s)) expect(s[m], `${why}: ${m}`).not.toBe('paused');
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A P1 runs on calendar time (24x7), so a credited pause is wall-clock minutes whatever the hour the test runs at. */
async function incident(title: string, opts: { p1?: boolean } = {}) {
  const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, serviceId: ids.service, title: `${title} ${S}`, description: 'sla pause', ...(opts.p1 ? { priorityId: ids.p1 } : {}) }));
  tickets.push(t.id);
  const rows = await slas(t.id);
  expect(rows.length, 'the default policy gives the ticket clocks').toBeGreaterThan(0);
  return t;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!adm) throw new Error('admin user missing (seed not applied?)');
    ids.adminUser = adm.id;
    for (const k of ['new', 'in_progress', 'pending_customer', 'pending_vendor', 'pending_change', 'on_hold', 'awaiting_approval', 'resolved', 'in_fulfilment']) st[k] = await optionId(tx, k);
    const [policy] = await tx.select({ id: schema.slaPolicies.id, pauseMetrics: schema.slaPolicies.pauseMetrics, pauseWaitingOn: schema.slaPolicies.pauseWaitingOn }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    ids.policy = policy!.id;
    PAUSABLE = policy!.pauseMetrics;
    FIRST_ANSWER = ['acknowledgement', 'response', 'restoration', 'resolution'].filter((m) => !PAUSABLE.includes(m));
    expect(PAUSABLE).toEqual(['resolution', 'restoration']);
    expect(policy!.pauseWaitingOn).toEqual(['customer', 'vendor', 'change', 'agreement']);
    const [p1] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), eq(schema.configOptions.key, 'p1'))).limit(1);
    ids.p1 = p1!.id;
    const [c] = await tx.insert(schema.customers).values({ code: `SP${S}`.toUpperCase(), name: `Pause Customer ${S}` }).returning();
    ids.customer = c.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site.id;
    const [svc] = await tx.insert(schema.services).values({ key: `sp_svc_${S}`, name: `Pause Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: c.id, number: `SP-${S}`, name: `Pause AMC ${S}`, status: 'active', startDate: day(-10), endDate: day(355), slaPolicyId: policy!.id }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: c.id, serviceId: svc.id });
    const [pa] = await tx.insert(schema.users).values({ email: `sp.admin.${S}@example.test`, name: 'Nisha Approver', userType: 'customer', customerId: c.id, status: 'active' }).returning();
    ids.portalAdmin = pa.id;
    await tx.insert(schema.userRoles).values({ userId: pa.id, roleId: await roleId(tx, 'customer_admin'), customerId: c.id });
    // Service manager first (internal: no pause), then the customer's administrator (pause).
    const [wf] = await tx.insert(schema.approvalWorkflows).values({ name: `Manager then customer ${S}`, steps: [{ name: 'Service manager', approverType: 'role', approverRef: 'service_manager' }, { name: 'Customer approval', approverType: 'customer_admin' }], isActive: true }).returning();
    ids.workflow = wf.id;
    const [cwf] = await tx.insert(schema.approvalWorkflows).values({ name: `Customer only ${S}`, steps: [{ name: 'Customer approval', approverType: 'customer_admin' }], isActive: true }).returning();
    ids.customerWorkflow = cwf.id;
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portalAdmin = (await loadPrincipal(ids.portalAdmin))!;
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets));
    await tx.delete(schema.slaPauseStatuses).where(and(eq(schema.slaPauseStatuses.policyId, ids.policy), eq(schema.slaPauseStatuses.statusId, st.pending_vendor!)));
    await tx.update(schema.configOptions).set({ pausesSla: true }).where(eq(schema.configOptions.id, st.pending_vendor!));
    await tx.delete(schema.approvalWorkflows).where(inArray(schema.approvalWorkflows.id, [ids.workflow, ids.customerWorkflow]));
    await tx.delete(schema.users).where(eq(schema.users.id, ids.portalAdmin));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('which clocks pause', () => {
  it('a customer wait before the first response pauses resolution and restoration and leaves response and acknowledgement running; the response clock breaches on the sweep while the ticket waits', async () => {
    const t = await incident('Before first response');
    expect((await stateOf(t.id)).response).toBe('running');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'Need the serial number' }));
    await expectPaused(t.id, 'customer wait');
    const rowIds = (await slas(t.id)).map((r) => r.id);
    const events = await withSystem((tx) => tx.select().from(schema.ticketSlaEvents).where(inArray(schema.ticketSlaEvents.ticketSlaId, rowIds)));
    const paused = events.filter((e) => e.eventType === 'paused');
    expect(paused.length).toBeGreaterThan(0);
    for (const e of paused) expect(e.details).toMatchObject({ waitingOn: 'customer', reason: 'Need the serial number' });
    // The provider still owes an answer: the response clock runs out while the ticket waits.
    await withSystem((tx) => tx.update(schema.ticketSlas).set({ dueAt: sql`now() - interval '1 minute'` }).where(and(eq(schema.ticketSlas.ticketId, t.id), eq(schema.ticketSlas.metric, 'response'))));
    await slaTick();
    const after = await stateOf(t.id);
    expect(after.response).toBe('breached');
    expect(after.resolution).toBe('paused');
  });

  it('an internal hold pauses nothing; an agreed hold, a supplier wait and a scheduled change pause', async () => {
    const t = await incident('Holds');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!, pendingReason: 'Waiting for the storage team', waitingOn: 'internal' }));
    await expectRunning(t.id, 'internal hold');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress! }));
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!, pendingReason: 'Customer asked us to wait until the audit', waitingOn: 'agreement' }));
    await expectPaused(t.id, 'agreed hold');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress! }));
    await expectRunning(t.id, 'back to work');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!, pendingReason: 'ISP case open' }));
    await expectPaused(t.id, 'supplier wait');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress! }));
    // The seed upgrade ships in this release: a fresh database has pending_change pausing.
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_change!, pendingReason: 'CHG-42 scheduled for Saturday' }));
    await expectPaused(t.id, 'scheduled change');
  });

  it('a wait-to-wait move pauses when the party moves to the customer and resumes with the minutes credited when it moves inside', async () => {
    const t = await incident('Wait to wait', { p1: true });
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!, pendingReason: 'parked', waitingOn: 'internal' }));
    await expectRunning(t.id, 'internal');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'Need the site contact' }));
    await expectPaused(t.id, 'internal → customer');
    const before = new Map((await slas(t.id)).filter((r) => r.state === 'paused').map((r) => [r.metric, r.dueAt.getTime()]));
    await withSystem((tx) => tx.update(schema.ticketSlas).set({ pausedAt: sql`now() - interval '10 minutes'` }).where(and(eq(schema.ticketSlas.ticketId, t.id), eq(schema.ticketSlas.state, 'paused'))));
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!, pendingReason: 'parked again', waitingOn: 'internal' }));
    await expectRunning(t.id, 'customer → internal');
    for (const r of (await slas(t.id)).filter((r) => PAUSABLE.includes(r.metric))) {
      expect(r.pausedMinutes, r.metric).toBe(10);
      expect(r.dueAt.getTime(), r.metric).toBe(before.get(r.metric)! + 10 * 60_000);
    }
  });

  it('a two-step approval (service manager, then the customer) runs unpaused for the internal step and paused once it reaches the customer, then resumes with the minutes credited', async () => {
    const r = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, siteId: ids.site, serviceId: ids.service, title: `Two-step request ${S}`, description: 'mixed steps', priorityId: ids.p1 }));
    tickets.push(r.id);
    expect((await slas(r.id)).length).toBeGreaterThan(0);
    const started = await asAdmin((ctx) => requestApproval(ctx, r.id, { approvalWorkflowId: ids.workflow, purpose: 'Approval for the pause test' }));
    const [step1, step2] = [...started.items].sort((a, b) => a.step - b.step);
    let ticket = started.ticket;
    expect(ticket.statusId).toBe(st.awaiting_approval!);
    expect(ticket.pendingWaitingOn).toBe('internal');
    await expectRunning(r.id, 'internal approver');
    await asAdmin((ctx) => decide(ctx, r.id, step1!.id, 'approved', 'Fine by me'));
    ticket = (await withSystem((tx) => tx.select().from(schema.tickets).where(eq(schema.tickets.id, r.id))))[0]!;
    expect(ticket.statusId).toBe(st.awaiting_approval!);
    expect(ticket.pendingWaitingOn).toBe('customer');
    await expectPaused(r.id, 'customer approver');
    await withSystem((tx) => tx.update(schema.ticketSlas).set({ pausedAt: sql`now() - interval '15 minutes'` }).where(and(eq(schema.ticketSlas.ticketId, r.id), eq(schema.ticketSlas.state, 'paused'))));
    await asPortalAdmin((ctx) => decide(ctx, r.id, step2!.id, 'approved', 'Approved'));
    ticket = (await withSystem((tx) => tx.select().from(schema.tickets).where(eq(schema.tickets.id, r.id))))[0]!;
    expect(ticket.statusId).toBe(st.in_fulfilment!);
    expect(ticket.approvalStatus).toBe('approved');
    expect(ticket.pendingWaitingOn).toBeNull();
    await expectRunning(r.id, 'after approval');
    for (const row of (await slas(r.id)).filter((x) => PAUSABLE.includes(x.metric) && !x.completedAt)) expect(row.pausedMinutes, row.metric).toBe(15);
  });

  it('reopening into a wait restarts resolution and restoration paused; starting in a wait applies the clocks paused; a policy pause status still pauses', async () => {
    // Under the strict profile an ended ticket reopens only into work; the default profile lets a resolved ticket go back to a wait.
    const t = await incident('Reopen into a wait');
    await asAdmin((ctx) => resolveTicket(ctx, t.id, { resolutionNotes: 'Done' }));
    await withSetting('tickets.transition_rules', 'strict', async () => {
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'back', comment: 'back' }))).rejects.toThrow(/cannot move from Resolved to Pending Customer/);
    });
    const back = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'back', comment: 'back' }));
    expect(back.statusId).toBe(st.pending_customer!);
    expect(back.reopenCount).toBe(1);
    await expectPaused(t.id, 'reopened into a customer wait');
    // A rejected request resubmitted for the customer's approval: the request reopens it (no manual reopen) and the clocks restart paused.
    const r = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, siteId: ids.site, serviceId: ids.service, title: `Resubmitted request ${S}`, description: 'resubmission' }));
    tickets.push(r.id);
    const first = await asAdmin((ctx) => requestApproval(ctx, r.id, { approvalWorkflowId: ids.customerWorkflow, purpose: 'Approval for the pause test' }));
    await expectPaused(r.id, 'first request');
    await asPortalAdmin((ctx) => decide(ctx, r.id, [...first.items].sort((a, b) => a.step - b.step)[0]!.id, 'rejected', 'Not now'));
    const rejected = await slas(r.id);
    for (const x of rejected.filter((x) => PAUSABLE.includes(x.metric))) expect(x.state, x.metric).toBe('cancelled');
    const again = await asAdmin((ctx) => requestApproval(ctx, r.id, { approvalWorkflowId: ids.customerWorkflow, purpose: 'Approval for the pause test' }));
    expect(again.ticket.statusId).toBe(st.awaiting_approval!);
    expect(again.ticket.reopenCount).toBe(1);
    const reopened = await slas(r.id);
    for (const x of reopened.filter((x) => PAUSABLE.includes(x.metric))) {
      expect(x.state, x.metric).toBe('paused');
      expect(x.pausedMinutes, x.metric).toBe(0);
    }
    for (const x of reopened.filter((x) => FIRST_ANSWER.includes(x.metric))) expect(x.state, x.metric).not.toBe('paused');

    // Creation in a wait: the engine applies resolution and restoration paused and the first-answer clocks running; an internal hold starts running.
    const u = await incident('Starts waiting');
    await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.pending_customer!, pendingWaitingOn: 'customer', pendingReason: 'Waiting from the start', pendingReasonVisible: true }).where(eq(schema.tickets.id, u.id)));
    await withSystem(async (tx) => {
      const [rowU] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, u.id));
      await applySlas(tx, rowU!, SYSTEM_ACTOR, { reason: 'recalculated' });
    });
    await expectPaused(u.id, 'applySlas in a customer wait');
    await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.on_hold!, pendingWaitingOn: 'internal', pendingReason: 'parked' }).where(eq(schema.tickets.id, u.id)));
    await withSystem(async (tx) => {
      const [rowU] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, u.id));
      await applySlas(tx, rowU!, SYSTEM_ACTOR, { reason: 'recalculated' });
    });
    await expectRunning(u.id, 'applySlas in an internal hold');

    // The policy's own pause list still pauses a status whose option does not.
    await withSystem(async (tx) => {
      await tx.update(schema.configOptions).set({ pausesSla: false }).where(eq(schema.configOptions.id, st.pending_vendor!));
      await tx.insert(schema.slaPauseStatuses).values({ policyId: ids.policy, statusId: st.pending_vendor! }).onConflictDoNothing();
    });
    const v = await incident('Policy pause');
    await asAdmin((ctx) => changeStatus(ctx, v.id, { statusId: st.pending_vendor!, pendingReason: 'with the supplier' }));
    await expectPaused(v.id, 'policy pause status');
  });
});

describe('the clock rule lives on the policy', () => {
  const metricStates = async (id: string) => stateOf(id);

  it('pause_metrics = {resolution} leaves the restoration clock running; adding response pauses the response clock before the first answer and the sweep does not breach it', async () => {
    await withPolicyPause(ids.policy, { metrics: ['resolution'] }, async () => {
      const t = await incident('Resolution only');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'Need the serial number' }));
      const s = await metricStates(t.id);
      expect(s.resolution).toBe('paused');
      if (s.restoration) expect(s.restoration).toBe('running');
      expect(s.response).toBe('running');
    });
    await withPolicyPause(ids.policy, { metrics: ['resolution', 'restoration', 'response'] }, async () => {
      const t = await incident('Response pauses too');
      expect((await metricStates(t.id)).response).toBe('running');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'Need the serial number' }));
      const s = await metricStates(t.id);
      expect(s.response).toBe('paused');
      expect(s.resolution).toBe('paused');
      if (s.acknowledgement) expect(s.acknowledgement).not.toBe('paused');
      await withSystem((tx) => tx.update(schema.ticketSlas).set({ dueAt: sql`now() - interval '1 minute'` }).where(and(eq(schema.ticketSlas.ticketId, t.id), eq(schema.ticketSlas.metric, 'response'))));
      await slaTick();
      expect((await metricStates(t.id)).response).toBe('paused');
      // The record reads the rule from the policy, not a constant.
      const detail = await asAdmin(async (ctx) => (await import('../src/modules/tickets/service')).getTicket(ctx, t.id));
      expect((detail as { pauseRule?: { metrics: string[]; waitingOn: string[] } }).pauseRule).toEqual({ metrics: ['resolution', 'restoration', 'response'], waitingOn: ['customer', 'vendor', 'change', 'agreement'] });
    });
  });

  it('pause_waiting_on with internal added pauses an internal hold and an internal approver step; with vendor removed a supplier wait keeps the clocks running', async () => {
    await withPolicyPause(ids.policy, { waitingOn: ['customer', 'vendor', 'change', 'agreement', 'internal'] }, async () => {
      const t = await incident('Internal pauses');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!, pendingReason: 'Waiting for the storage team', waitingOn: 'internal' }));
      await expectPaused(t.id, 'internal hold under a policy that pauses for it');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress! }));
      await expectRunning(t.id, 'back to work');
      const r = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, siteId: ids.site, serviceId: ids.service, title: `Internal approver pauses ${S}`, description: 'policy', priorityId: ids.p1 }));
      tickets.push(r.id);
      const started = await asAdmin((ctx) => requestApproval(ctx, r.id, { approvalWorkflowId: ids.workflow, purpose: 'Approval for the pause test' }));
      expect(started.ticket.pendingWaitingOn).toBe('internal');
      await expectPaused(r.id, 'internal approver under a policy that pauses for it');
    });
    await withPolicyPause(ids.policy, { waitingOn: ['customer', 'change', 'agreement'] }, async () => {
      const t = await incident('Supplier runs');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!, pendingReason: 'ISP case open' }));
      await expectRunning(t.id, 'supplier wait under a policy that does not pause for it');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!, pendingReason: 'Need the site contact' }));
      await expectPaused(t.id, 'customer wait still pauses');
    });
  });

  it('the reopen restart restarts resolution and restoration only, whatever the policy pauses: a met response row is untouched', async () => {
    await withPolicyPause(ids.policy, { metrics: ['resolution', 'restoration', 'response'] }, async () => {
      const t = await incident('Reopen restart');
      await withSystem(async (tx) => {
        const [rowT] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, t.id));
        await markResponded(tx, rowT!, SYSTEM_ACTOR);
      });
      const responded = (await slas(t.id)).find((r) => r.metric === 'response')!;
      expect(responded.state).toBe('met');
      await asAdmin((ctx) => resolveTicket(ctx, t.id, { resolutionNotes: 'Done' }));
      await asAdmin((ctx) => reopenTicket(ctx, t.id, { comment: 'It came back' }));
      const after = await slas(t.id);
      const response = after.find((r) => r.metric === 'response')!;
      expect(response.state).toBe('met');
      expect(response.completedAt?.toISOString()).toBe(responded.completedAt?.toISOString());
      for (const r of after.filter((x) => x.metric === 'resolution' || x.metric === 'restoration')) {
        expect(r.state, r.metric).toBe('running');
        expect(r.completedAt, r.metric).toBeNull();
      }
    });
  });

  it('applySlas on a ticket created in a wait honours both fields', async () => {
    await withPolicyPause(ids.policy, { metrics: ['resolution', 'response'], waitingOn: ['customer', 'internal'] }, async () => {
      const u = await incident('Starts waiting on the policy');
      await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.on_hold!, pendingWaitingOn: 'internal', pendingReason: 'parked' }).where(eq(schema.tickets.id, u.id)));
      await withSystem(async (tx) => {
        const [rowU] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, u.id));
        await applySlas(tx, rowU!, SYSTEM_ACTOR, { reason: 'recalculated' });
      });
      const s = await metricStates(u.id);
      expect(s.resolution).toBe('paused');
      expect(s.response).toBe('paused');
      if (s.restoration) expect(s.restoration).toBe('running');
      await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.pending_vendor!, pendingWaitingOn: 'vendor', pendingReason: 'ISP' }).where(eq(schema.tickets.id, u.id)));
      await withSystem(async (tx) => {
        const [rowU] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, u.id));
        await applySlas(tx, rowU!, SYSTEM_ACTOR, { reason: 'recalculated' });
      });
      await expectRunning(u.id, 'a supplier wait the policy does not pause for');
    });
  });
});
