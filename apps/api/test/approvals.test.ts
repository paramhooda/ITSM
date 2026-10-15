/**
 * Approvals as a lifecycle step on every ticket type (DB-backed): a request names the
 * approver, the purpose and a due date; the ticket waits in Awaiting Approval with its
 * resolution and restoration clocks paused while a customer decides and running for an
 * internal approver; the requester is told the ticket waits on their organisation; a
 * decision returns the ticket to work (approved) or applies the type's rejection path;
 * steps of a workflow run in order and re-point the party; withdraw, the auto-cancel on
 * an ended ticket, the hourly reminder and expiry job under the three policies, the
 * refusals and the isolation between organisations.
 * Run with the dev environment sourced: npx vitest run test/approvals.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { config } from '../src/config';
import { createTicket, resolveTicket, cancelTicket, reopenTicket, getTicket, changeStatus } from '../src/modules/tickets/service';
import { addComment } from '../src/modules/tickets/activity';
import * as approvals from '../src/modules/tickets/approvals';
import * as portal from '../src/modules/portal/service';
import { withSetting } from './_settings';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-approvals-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let portalAdmin: Principal;
let portalUser: Principal;
let portalAdminB: Principal;
let manager: Principal;
const ids = { customer: '', customerB: '', site: '', service: '', contract: '', cab: '', mixed: '', adminUser: '', portalAdmin: '', portalUser: '', portalAdminB: '', manager: '' };
const st: Record<string, string> = {};
const ticketIds: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortalAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalAdmin, meta, fn);
const asPortalUser = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalUser, meta, fn);
const asPortalAdminB = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalAdminB, meta, fn);
const asManager = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(manager, meta, fn);

/** The clocks the default policy pauses, read from its `pause_metrics` in beforeAll (the shipped rule is the column default). */
let PAUSABLE: string[] = [];
let FIRST_ANSWER: string[] = [];
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const dayStr = (offset: number) => day(offset).toISOString().slice(0, 10);

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing`);
  return row.id;
}
const row = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1))[0]!);
const slas = (id: string) => withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, id)));
const steps = (id: string) => withSystem((tx) => tx.select().from(schema.approvals).where(eq(schema.approvals.ticketId, id)).orderBy(desc(schema.approvals.createdAt), schema.approvals.step));
const activities = (id: string, type?: string) => withSystem((tx) => tx.select().from(schema.ticketActivities).where(type ? and(eq(schema.ticketActivities.ticketId, id), eq(schema.ticketActivities.activityType, type)) : eq(schema.ticketActivities.ticketId, id)).orderBy(desc(schema.ticketActivities.createdAt)));
const comments = (id: string) => withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, id)).orderBy(desc(schema.ticketComments.createdAt)));
const outbox = (id: string, event: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.entityId, id), eq(schema.notificationOutbox.event, event))));
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never } }));
const statusesOf = (items: { step: number; status: string }[]) => [...items].sort((a, b) => a.step - b.step).map((a) => a.status);
const firstStep = (items: { step: number; id: string }[]) => [...items].sort((a, b) => a.step - b.step)[0]!;

async function expectPaused(id: string, label: string) {
  const rows = await slas(id);
  expect(rows.length, `${label}: SLA rows`).toBeGreaterThan(0);
  for (const r of rows.filter((x) => PAUSABLE.includes(x.metric) && !x.completedAt)) expect(r.state, `${label}: ${r.metric}`).toBe('paused');
  for (const r of rows.filter((x) => FIRST_ANSWER.includes(x.metric) && !x.completedAt)) expect(r.state, `${label}: ${r.metric}`).not.toBe('paused');
}
async function expectRunning(id: string, label: string) {
  const rows = await slas(id);
  expect(rows.length, `${label}: SLA rows`).toBeGreaterThan(0);
  for (const r of rows.filter((x) => !x.completedAt)) {
    expect(r.state, `${label}: ${r.metric}`).not.toBe('paused');
    expect(r.pausedAt, `${label}: ${r.metric} pausedAt`).toBeNull();
  }
}
/** Moves the pause back in time so the credited minutes can be asserted. */
const pausedFor = (id: string, minutes: number) => withSystem((tx) => tx.update(schema.ticketSlas).set({ pausedAt: sql`now() - (${minutes} || ' minutes')::interval` }).where(and(eq(schema.ticketSlas.ticketId, id), eq(schema.ticketSlas.state, 'paused'))));

async function newTicket(type: 'incident' | 'request' | 'problem' | 'change', title: string, opts: { requesterUserId?: string | null; customerId?: string } = {}) {
  const t = await asAdmin((ctx) => createTicket(ctx, { type, customerId: opts.customerId ?? ids.customer, siteId: opts.customerId ? undefined : ids.site, serviceId: ids.service, title: `${title} ${S}`, description: `${title}: needs a decision`, requesterUserId: opts.requesterUserId === undefined ? ids.portalUser : opts.requesterUserId } as never));
  ticketIds.push(t.id);
  return t;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!adm) throw new Error('admin user missing (seed not applied?)');
    ids.adminUser = adm.id;
    for (const k of ['new', 'in_progress', 'in_fulfilment', 'under_investigation', 'awaiting_approval', 'approved', 'rejected', 'resolved', 'cancelled', 'pending_vendor']) {
      const [o] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, k))).limit(1);
      if (!o) throw new Error(`status ${k} missing`);
      st[k] = o.id;
    }
    const [cab] = await tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.name, 'CAB approval')).limit(1);
    if (!cab) throw new Error('"CAB approval" workflow missing (seed not applied?)');
    ids.cab = cab.id;
    const [mixed] = await tx.insert(schema.approvalWorkflows).values({ name: `Manager then customer ${S}`, steps: [{ name: 'Service manager', approverType: 'role', approverRef: 'service_manager' }, { name: 'Customer approval', approverType: 'customer_admin' }], isActive: true }).returning();
    ids.mixed = mixed.id;
    const [policy] = await tx.select({ id: schema.slaPolicies.id, pauseMetrics: schema.slaPolicies.pauseMetrics }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    PAUSABLE = policy?.pauseMetrics ?? ['resolution', 'restoration'];
    FIRST_ANSWER = ['acknowledgement', 'response', 'restoration', 'resolution'].filter((m) => !PAUSABLE.includes(m));
    for (const k of ['draft']) {
      const [o] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, k))).limit(1);
      st[k] = o!.id;
    }
    const [c] = await tx.insert(schema.customers).values({ code: `APR${S.toUpperCase()}`, name: `Approvals Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [cb] = await tx.insert(schema.customers).values({ code: `APB${S.toUpperCase()}`, name: `Other Organisation ${S}` }).returning();
    ids.customerB = cb!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `apr_svc_${S}`, name: `Approvals Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: c!.id, number: `APR-${S}`, name: `Approvals AMC ${S}`, status: 'active', startDate: dayStr(-10), endDate: dayStr(355), slaPolicyId: policy?.id ?? null }).returning();
    ids.contract = contract!.id;
    await tx.insert(schema.contractServices).values({ contractId: contract!.id, customerId: c!.id, serviceId: svc!.id });
    await tx.insert(schema.scopeItems).values({ contractId: contract!.id, customerId: c!.id, serviceId: svc!.id, name: 'Everything', classification: 'in_scope' });
    const [pu] = await tx.insert(schema.users).values({ email: `apr.user.${S}@example.test`, name: 'Ritu Requester', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    const [pa] = await tx.insert(schema.users).values({ email: `apr.admin.${S}@example.test`, name: 'Manish Approver', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    const [pb] = await tx.insert(schema.users).values({ email: `apr.adminb.${S}@example.test`, name: 'Bela Other', userType: 'customer', customerId: cb!.id, status: 'active' }).returning();
    const [mgr] = await tx.insert(schema.users).values({ email: `apr.manager.${S}@example.test`, name: 'Sana Manager', userType: 'msp', status: 'active' }).returning();
    ids.portalUser = pu!.id;
    ids.portalAdmin = pa!.id;
    ids.portalAdminB = pb!.id;
    ids.manager = mgr!.id;
    await tx.insert(schema.userRoles).values([
      { userId: pu!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id },
      { userId: pa!.id, roleId: await roleId(tx, 'customer_admin'), customerId: c!.id },
      { userId: pb!.id, roleId: await roleId(tx, 'customer_admin'), customerId: cb!.id },
      { userId: mgr!.id, roleId: await roleId(tx, 'service_manager') },
    ]);
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portalAdmin = (await loadPrincipal(ids.portalAdmin))!;
  portalUser = (await loadPrincipal(ids.portalUser))!;
  portalAdminB = (await loadPrincipal(ids.portalAdminB))!;
  manager = (await loadPrincipal(ids.manager))!;
});

afterAll(async () => {
  await setSetting('approvals.expiry_policy', 'return');
  await withSystem(async (tx) => {
    if (ticketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, ticketIds));
    await tx.delete(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, ids.mixed));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.portalUser, ids.portalAdmin, ids.portalAdminB, ids.manager]));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.customer, ids.customerB]));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('approval steps run in order (the CAB workflow on a change)', () => {
  it('opens only the first step, releases the next on approval, and completes when the last is approved', async () => {
    const t = await newTicket('change', 'Two-step change', { requesterUserId: null });
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the two-step change' }));
    expect(statusesOf(started.items)).toEqual(['pending', 'waiting']);
    expect(started.items.every((a) => a.purpose === 'CAB approval for the two-step change' && a.dueAt && a.requestedBy === ids.adminUser)).toBe(true);
    const [step1, step2] = [...started.items].sort((a, b) => a.step - b.step);

    // Nobody sees step 2 in their inbox yet, and it cannot be decided before step 1.
    const inbox = await asAdmin((ctx) => approvals.listMine(ctx));
    expect(inbox.items.some((a) => a.id === step2!.id)).toBe(false);
    await expect(asAdmin((ctx) => approvals.decide(ctx, t.id, step2!.id, 'approved'))).rejects.toThrow(/Step 1 must be decided/);

    const afterFirst = await asAdmin((ctx) => approvals.decide(ctx, t.id, step1!.id, 'approved', 'CAB ok'));
    expect(statusesOf(afterFirst.items)).toEqual(['approved', 'pending']);
    expect(afterFirst.approvalStatus).toBe('pending');

    const done = await asAdmin((ctx) => approvals.decide(ctx, t.id, step2!.id, 'approved'));
    expect(statusesOf(done.items)).toEqual(['approved', 'approved']);
    expect(done.approvalStatus).toBe('approved');
    expect((await row(t.id)).statusId).toBe(st.approved);
  });

  it('approvals.rejected_change = rejected: a rejection at the first step skips the rest and ends the change as Rejected; a new request resubmits it through Draft', async () => {
    await withSetting('approvals.rejected_change', 'rejected', async () => {
      const t = await newTicket('change', 'Rejected change', { requesterUserId: null });
      const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the rejected change' }));
      const res = await asAdmin((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'rejected', 'Not this week'));
      expect(statusesOf(res.items)).toEqual(['rejected', 'skipped']);
      expect(res.approvalStatus).toBe('rejected');
      expect((await row(t.id)).statusId).toBe(st.rejected);
      // A rejected change is resubmitted by the next request: reopened to Draft (never to its working status), then requested; the old steps are superseded and it starts again at step 1.
      const again = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval, second submission' }));
      expect(statusesOf(again.items.filter((a) => a.status !== 'superseded' && a.status !== 'rejected' && a.status !== 'skipped'))).toEqual(['pending', 'waiting']);
      const r = await row(t.id);
      expect(r.statusId).toBe(st.awaiting_approval);
      expect(r.reopenCount).toBe(1);
      const trail = (await activities(t.id, 'status')).map((a) => (a.data as { to?: { key: string } }).to?.key).reverse();
      expect(trail.slice(-3)).toEqual(['rejected', 'draft', 'awaiting_approval']);
      expect((await comments(t.id)).some((c) => c.body === 'Resubmitted for approval: CAB approval, second submission' && !c.isInternal)).toBe(true);
    });
  });

  it('approvals.rejected_change = return (the default): the change returns to Draft with the note posted, the requester is told, and a new request moves it straight to Awaiting Approval', async () => {
    const t = await newTicket('change', 'Returned change');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the returned change' }));
    const res = await asManager((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'rejected', 'Add the DR validation results'));
    expect(statusesOf(res.items)).toEqual(['rejected', 'skipped']);
    expect(res.approvalStatus).toBe('rejected');
    const r = await row(t.id);
    expect(r.statusId).toBe(st.draft);
    expect(r.approvalStatus).toBe('rejected');
    expect(r.pendingWaitingOn).toBeNull();
    expect(r.closedAt).toBeNull();
    expect((await comments(t.id)).some((c) => c.body === 'Add the DR validation results' && !c.isInternal)).toBe(true);
    expect((await activities(t.id, 'status'))[0]!.summary).toMatch(/^Rejected by Sana Manager: Add the DR validation results · back to Draft to be revised$/);
    expect((await activities(t.id, 'pending'))[0]!.summary).toBe('Resumed · the request was rejected');
    const told = await outbox(t.id, 'approval.rejected');
    expect(told.map((o) => o.recipient)).toContain(`apr.user.${S}@example.test`);
    // Draft → Awaiting Approval is a plain move: the next request needs no reopen.
    const again = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval, second submission' }));
    const r2 = await row(t.id);
    expect(r2.statusId).toBe(st.awaiting_approval);
    expect(r2.reopenCount).toBe(0);
    expect(statusesOf(again.items.filter((a) => a.status !== 'superseded' && a.status !== 'rejected' && a.status !== 'skipped'))).toEqual(['pending', 'waiting']);
    expect((await comments(t.id)).some((c) => /Resubmitted for approval/.test(c.body))).toBe(false);

    // A wait entered by hand while the approval ran stays: the note is posted, the status is left alone.
    const v = await newTicket('change', 'Held change');
    const s2 = await asAdmin((ctx) => approvals.requestApproval(ctx, v.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the held change' }));
    await asAdmin((ctx) => changeStatus(ctx, v.id, { statusId: st.pending_vendor!, pendingReason: 'Waiting for the vendor quote' }));
    await asManager((ctx) => approvals.decide(ctx, v.id, firstStep(s2.items).id, 'rejected', 'Not without the quote'));
    const held = await row(v.id);
    expect(held.statusId).toBe(st.pending_vendor);
    expect(held.approvalStatus).toBe('rejected');
    expect((await comments(v.id)).some((c) => c.body === 'Not without the quote' && !c.isInternal)).toBe(true);

    // A rejected request resubmits to Awaiting Approval through In Fulfilment (a request ends as Rejected whatever the setting).
    const q = await newTicket('request', 'Resubmitted request');
    const s3 = await asAdmin((ctx) => approvals.requestApproval(ctx, q.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the licence' }));
    await asPortalAdmin((ctx) => approvals.decide(ctx, q.id, firstStep(s3.items).id, 'rejected', 'Not this quarter'));
    expect((await row(q.id)).statusId).toBe(st.rejected);
    const s4 = await asAdmin((ctx) => approvals.requestApproval(ctx, q.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the licence (revised quote)' }));
    expect(s4.ticket.statusId).toBe(st.awaiting_approval);
    expect(s4.ticket.reopenCount).toBe(1);
    const qTrail = (await activities(q.id, 'status')).map((a) => (a.data as { to?: { key: string } }).to?.key).reverse();
    expect(qTrail.slice(-3)).toEqual(['rejected', 'in_fulfilment', 'awaiting_approval']);
    expect((await comments(q.id)).some((c) => c.body === 'Approve the licence (revised quote)' || c.body === 'Resubmitted for approval: Approve the licence (revised quote)')).toBe(true);
    // A resolved ticket is still refused: resolving is not a rejection.
    const done = await newTicket('incident', 'Resolved, not rejected');
    await asAdmin((ctx) => resolveTicket(ctx, done.id, { resolutionNotes: 'Fixed' }));
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, done.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve something' }))).rejects.toThrow(/is resolved; reopen it/);
  });
});

describe('an approval on an incident, decided by the customer administrator in the portal', () => {
  it('pauses the resolution and restoration clocks, tells the approvers and the requester, and the decision brings the ticket back with the minutes credited', async () => {
    const t = await newTicket('incident', 'UPS batteries');
    const due = day(2);
    const res = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the replacement of the failed UPS batteries (chargeable)', dueAt: due }));
    expect(res.items.map((a) => a.status)).toEqual(['pending']);
    expect(res.items[0]!.approverRole?.key).toBe('customer_admin');
    expect(res.items[0]!.purpose).toBe('Approve the replacement of the failed UPS batteries (chargeable)');
    expect(res.items[0]!.dueAt?.toISOString()).toBe(due.toISOString());
    expect(res.items[0]!.requestedByUser?.id).toBe(ids.adminUser);
    let r = await row(t.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.approvalStatus).toBe('pending');
    expect(r.pendingWaitingOn).toBe('customer');
    expect(r.pendingReason).toBe('Approve the replacement of the failed UPS batteries (chargeable)');
    expect(r.pendingExpectedAt?.toISOString()).toBe(due.toISOString());
    await expectPaused(t.id, 'customer approver');

    // The approvers hear approval.requested (the organisation's administrators), the requester hears that the ticket waits on their organisation.
    const toApprovers = await outbox(t.id, 'approval.requested');
    expect(toApprovers.map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);
    expect(toApprovers.find((o) => o.channel === 'email')?.body).toMatch(/replacement of the failed UPS batteries/);
    const toRequester = await outbox(t.id, 'ticket.pending');
    expect(toRequester.map((o) => o.recipient)).toEqual([`apr.user.${S}@example.test`]);
    expect(toRequester[0]!.body).toMatch(/Your organisation(&#x27;|')s approval is needed/);
    // The subject is plain text: the apostrophe of the label is never an HTML entity there.
    expect(toRequester[0]!.subject).toContain("Your organisation's approval is needed");
    expect(toRequester[0]!.body).not.toMatch(/awaiting_approval|internal/);
    // The timeline: the request is customer-visible (a customer party) and names the approver, the purpose and the due date.
    const act = (await activities(t.id, 'approval'))[0]!;
    expect(act.customerVisible).toBe(true);
    expect(act.summary).toMatch(/^Approval requested from the administrators of Approvals Customer/);
    expect(act.summary).toMatch(/Approve the replacement of the failed UPS batteries \(chargeable\) · by \d+ \w+ \d{4}$/);
    // The staff record carries the wait with the staff label; the customer reads it in their own words.
    const detail = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(detail.pending?.waitingOnLabel).toBe("Awaiting the customer's approval");
    const mine = await asPortalAdmin((ctx) => portal.getPortalTicket(ctx, t.id));
    expect(mine.pending).toEqual({ waitingOn: 'customer', waitingOnLabel: 'Your approval is needed', reason: 'Approve the replacement of the failed UPS batteries (chargeable)', expectedAt: due });
    expect((await asPortalUser((ctx) => portal.getPortalTicket(ctx, t.id))).pending?.waitingOnLabel).toBe("Your organisation's approval is needed");
    expect(mine.pendingForMe.length).toBe(1);
    expect(mine.pendingForMe[0]).toMatchObject({ purpose: 'Approve the replacement of the failed UPS batteries (chargeable)', requestedByName: admin.name });

    // A customer comment while the approval is pending is a comment: the status and the approval stay.
    await asPortalUser((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Our director is back on Monday' }));
    r = await row(t.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.approvalStatus).toBe('pending');
    await expectPaused(t.id, 'after the customer comment');

    // The portal inbox carries the purpose and the due date; the administrator approves with a note.
    const inbox = await asPortalAdmin((ctx) => portal.listPortalApprovals(ctx));
    const pending = inbox.items.find((a) => a.ticket.id === t.id)!;
    expect(pending).toMatchObject({ purpose: 'Approve the replacement of the failed UPS batteries (chargeable)', requestedByName: admin.name });
    expect(pending.dueAt?.toISOString()).toBe(due.toISOString());
    await pausedFor(t.id, 24 * 60);
    const decided = await asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, t.id, pending.id, 'approved', 'Go ahead, PO 4411'));
    expect(decided.approvalStatus).toBe('approved');
    r = await row(t.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('approved');
    expect(r.pendingWaitingOn).toBeNull();
    await expectRunning(t.id, 'after the approval');
    for (const x of (await slas(t.id)).filter((x) => PAUSABLE.includes(x.metric) && !x.completedAt)) expect(x.pausedMinutes, x.metric).toBeGreaterThan(0);
    const approvedRows = await outbox(t.id, 'approval.approved');
    expect(approvedRows.length).toBeGreaterThan(0);
    expect(approvedRows[0]!.body).toMatch(/Go ahead, PO 4411/);
    const after = await asPortalUser((ctx) => portal.getPortalTicket(ctx, t.id));
    expect(after.timeline.some((i) => i.kind === 'activity' && /approved by Manish Approver: Go ahead, PO 4411/.test(i.summary ?? ''))).toBe(true);
    expect(after.timeline.some((i) => i.kind === 'activity' && /Approved by Manish Approver · back with the service desk as In Progress/.test(i.summary ?? ''))).toBe(true);
    expect(after.pending).toBeNull();
  });

  it('an administrator who raised the ticket and must approve it gets the approval message only', async () => {
    const t = await newTicket('incident', 'Raised by the administrator', { requesterUserId: ids.portalAdmin });
    await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin', ref: ids.portalAdmin }, purpose: 'Approve the chargeable site visit' }));
    expect((await outbox(t.id, 'approval.requested')).map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);
    expect((await outbox(t.id, 'ticket.pending')).map((o) => o.recipient)).not.toContain(`apr.admin.${S}@example.test`);
    const [stepRow] = await steps(t.id);
    expect(stepRow!.approverUserId).toBe(ids.portalAdmin);
    expect((await row(t.id)).pendingWaitingOn).toBe('customer');
  });
});

describe('the workflow re-points the party on every step', () => {
  it('service manager then the customer: unpaused for the internal step, paused once released to the administrators, who are told on release', async () => {
    const t = await newTicket('incident', 'Mixed steps');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.mixed, purpose: 'Approve the out-of-hours work' }));
    const [step1, step2] = [...started.items].sort((a, b) => a.step - b.step);
    let r = await row(t.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.pendingWaitingOn).toBe('internal');
    await expectRunning(t.id, 'internal approver');
    expect((await outbox(t.id, 'ticket.pending')).length).toBe(0);
    // The request's row is internal while the step is internal; the customer sees no wait.
    expect((await activities(t.id, 'approval'))[0]!.customerVisible).toBe(false);
    expect((await asPortalUser((ctx) => portal.getPortalTicket(ctx, t.id))).pending).toBeNull();

    await asAdmin((ctx) => approvals.decide(ctx, t.id, step1!.id, 'approved', 'Fine by me'));
    r = await row(t.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.pendingWaitingOn).toBe('customer');
    expect(r.approvalStatus).toBe('pending');
    await expectPaused(t.id, 'released to the customer');
    expect((await outbox(t.id, 'approval.requested')).map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);
    expect((await outbox(t.id, 'ticket.pending')).map((o) => o.recipient)).toEqual([`apr.user.${S}@example.test`]);
    expect(statusesOf((await asAdmin((ctx) => approvals.listForTicket(ctx, t.id))).items)).toEqual(['approved', 'pending']);
    await asPortalAdmin((ctx) => approvals.decide(ctx, t.id, step2!.id, 'approved', 'Approved'));
    r = await row(t.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('approved');
    await expectRunning(t.id, 'after the second decision');
  });
});

describe('rejection per type', () => {
  it('an incident returns to the engineer with the note posted; approval_status is rejected and nothing is auto-cancelled', async () => {
    const t = await newTicket('incident', 'Rejected incident');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the chargeable replacement' }));
    await expect(asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, t.id, firstStep(started.items).id, 'rejected', ''))).rejects.toThrow(/Say why/);
    const res = await asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, t.id, firstStep(started.items).id, 'rejected', 'Too expensive, repair it instead'));
    expect(res.approvalStatus).toBe('rejected');
    const r = await row(t.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('rejected');
    expect(r.pendingWaitingOn).toBeNull();
    await expectRunning(t.id, 'after the rejection');
    const note = (await comments(t.id)).find((c) => c.body === 'Too expensive, repair it instead');
    expect(note?.isInternal).toBe(false);
    expect((await activities(t.id, 'approval')).some((a) => /withdrawn/.test(a.summary))).toBe(false);
    expect((await activities(t.id, 'status'))[0]!.summary).toMatch(/Rejected by Manish Approver: Too expensive, repair it instead · back with the service desk as In Progress/);
    expect((await outbox(t.id, 'approval.rejected')).length).toBeGreaterThan(0);
  });

  it('a request ends as Rejected with the note posted', async () => {
    const t = await newTicket('request', 'Rejected request');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the licence purchase' }));
    await asPortalAdmin((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'rejected', 'No budget this quarter'));
    const r = await row(t.id);
    expect(r.statusId).toBe(st.rejected);
    expect(r.approvalStatus).toBe('rejected');
    expect((await comments(t.id)).some((c) => c.body === 'No budget this quarter' && !c.isInternal)).toBe(true);
  });

  it('a problem returns to Under Investigation', async () => {
    const t = await newTicket('problem', 'Rejected problem', { requesterUserId: null });
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'role', ref: 'service_manager' }, purpose: 'Approve the vendor engagement' }));
    await asAdmin((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'rejected', 'Try the workaround first'));
    const r = await row(t.id);
    expect(r.statusId).toBe(st.under_investigation);
    expect(r.approvalStatus).toBe('rejected');
  });

  it('approvals.rejected_change changes only the change: the other types reject the same way under both values', async () => {
    for (const value of ['return', 'rejected'] as const) {
      await withSetting('approvals.rejected_change', value, async () => {
        const inc = await newTicket('incident', `Rejected incident under ${value}`);
        const si = await asAdmin((ctx) => approvals.requestApproval(ctx, inc.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the chargeable replacement' }));
        await asPortalAdmin((ctx) => approvals.decide(ctx, inc.id, firstStep(si.items).id, 'rejected', 'Repair it instead'));
        expect((await row(inc.id)).statusId, `incident under ${value}`).toBe(st.in_progress);
        const req = await newTicket('request', `Rejected request under ${value}`);
        const sr = await asAdmin((ctx) => approvals.requestApproval(ctx, req.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the licence' }));
        await asPortalAdmin((ctx) => approvals.decide(ctx, req.id, firstStep(sr.items).id, 'rejected', 'No budget'));
        expect((await row(req.id)).statusId, `request under ${value}`).toBe(st.rejected);
        const prb = await newTicket('problem', `Rejected problem under ${value}`, { requesterUserId: null });
        const sp = await asAdmin((ctx) => approvals.requestApproval(ctx, prb.id, { approver: { kind: 'role', ref: 'service_manager' }, purpose: 'Approve the vendor engagement' }));
        await asAdmin((ctx) => approvals.decide(ctx, prb.id, firstStep(sp.items).id, 'rejected', 'Workaround first'));
        expect((await row(prb.id)).statusId, `problem under ${value}`).toBe(st.under_investigation);
        const chg = await newTicket('change', `Rejected change under ${value}`, { requesterUserId: null });
        const sc = await asAdmin((ctx) => approvals.requestApproval(ctx, chg.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the change' }));
        await asManager((ctx) => approvals.decide(ctx, chg.id, firstStep(sc.items).id, 'rejected', 'Not yet'));
        expect((await row(chg.id)).statusId, `change under ${value}`).toBe(value === 'return' ? st.draft : st.rejected);
      });
    }
  });

  it('approvals.rejection_note_required: portal (the default) holds customer approvers to a note, none holds nobody, all holds staff too', async () => {
    const mk = async (title: string) => {
      const t = await newTicket('incident', title);
      const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the chargeable work' }));
      return { t, step: firstStep(started.items) };
    };
    const a = await mk('Note by default');
    await expect(asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, a.t.id, a.step.id, 'rejected', '  '))).rejects.toThrow(/Say why/);
    await asAdmin((ctx) => approvals.decide(ctx, a.t.id, a.step.id, 'rejected'));
    expect((await row(a.t.id)).approvalStatus).toBe('rejected');
    await withSetting('approvals.rejection_note_required', 'none', async () => {
      const b = await mk('Note never');
      const res = await asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, b.t.id, b.step.id, 'rejected', ''));
      expect(res.approvalStatus).toBe('rejected');
      expect((await row(b.t.id)).statusId).toBe(st.in_progress);
    });
    await withSetting('approvals.rejection_note_required', 'all', async () => {
      const c = await mk('Note always');
      await expect(asAdmin((ctx) => approvals.decide(ctx, c.t.id, c.step.id, 'rejected'))).rejects.toThrow(/Say why/);
      await expect(asPortalAdmin((ctx) => portal.decidePortalApproval(ctx, c.t.id, c.step.id, 'rejected', null))).rejects.toThrow(/Say why/);
      await asAdmin((ctx) => approvals.decide(ctx, c.t.id, c.step.id, 'approved'));
      expect((await row(c.t.id)).approvalStatus).toBe('approved');
    });
  });
});

describe('internal approvers and refusals', () => {
  it('an internal approver pauses nothing and writes no customer-visible row', async () => {
    const t = await newTicket('incident', 'Internal approver');
    await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'role', ref: 'service_manager' }, purpose: 'Approve the overtime' }));
    const r = await row(t.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.pendingWaitingOn).toBe('internal');
    await expectRunning(t.id, 'internal approver');
    expect((await activities(t.id)).filter((a) => a.customerVisible && /Approve the overtime|Awaiting Approval/.test(a.summary)).length).toBe(0);
    expect((await outbox(t.id, 'ticket.pending')).length).toBe(0);
    const mine = await asPortalUser((ctx) => portal.getPortalTicket(ctx, t.id));
    expect(mine.pending).toBeNull();
    expect(mine.approvals).toEqual([]);
    expect(JSON.stringify(mine)).not.toMatch(/Approve the overtime|internal/);
    // The decision of an internal step stays with the desk: no customer-visible row, nothing queued to the requester.
    const [stepRow] = await steps(t.id);
    await asAdmin((ctx) => approvals.decide(ctx, t.id, stepRow!.id, 'approved', 'Overtime approved'));
    expect((await row(t.id)).statusId).toBe(st.in_progress);
    expect((await activities(t.id)).filter((a) => a.customerVisible && /Overtime approved|approved by/.test(a.summary)).length).toBe(0);
    expect((await outbox(t.id, 'approval.approved')).map((o) => o.recipient)).not.toContain(`apr.user.${S}@example.test`);
    expect(JSON.stringify(await asPortalUser((ctx) => portal.getPortalTicket(ctx, t.id)))).not.toMatch(/Overtime approved|Approve the overtime/);
  });

  it('refuses a user who is not an administrator of the customer, a request on an ended ticket, both a workflow and an approver, and a decision on a resolved ticket', async () => {
    const t = await newTicket('incident', 'Refusals');
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'user', ref: ids.portalUser }, purpose: 'Approve this' }))).rejects.toThrow(/Ritu Requester is not an administrator of Approvals Customer .* and cannot approve/);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'user', ref: ids.portalAdminB }, purpose: 'Approve this' }))).rejects.toThrow(/is not an administrator of Approvals Customer/);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.mixed, approver: { kind: 'customer_admin' }, purpose: 'Approve this' }))).rejects.toThrow(/either a workflow or an approver/);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'role', ref: 'no_such_role' }, purpose: 'Approve this' }))).rejects.toThrow(/No role/);
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve this' }));
    await asAdmin((ctx) => resolveTicket(ctx, t.id, { resolutionNotes: 'Fixed without the part' }));
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve this' }))).rejects.toThrow(/is resolved; reopen it/);
    await expect(asPortalAdmin((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'approved'))).rejects.toThrow(/already been decided|is resolved/);
  });

  it('fails loudly when the status is not configured for the type', async () => {
    const t = await newTicket('problem', 'No status', { requesterUserId: null });
    await withSystem((tx) => tx.update(schema.configOptions).set({ appliesTo: ['request', 'change'] }).where(eq(schema.configOptions.id, st.awaiting_approval!)));
    try {
      await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve this' }))).rejects.toThrow(/does not apply to problem tickets/);
      expect((await steps(t.id)).length).toBe(0);
      expect((await row(t.id)).approvalStatus).not.toBe('pending');
    } finally {
      await withSystem((tx) => tx.update(schema.configOptions).set({ appliesTo: [] }).where(eq(schema.configOptions.id, st.awaiting_approval!)));
    }
  });
});

describe('withdraw and the auto-cancel', () => {
  it('withdraw tells the approvers, cancels the steps and brings the ticket back with the clocks resumed', async () => {
    const t = await newTicket('incident', 'Withdrawn');
    await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the part' }));
    await expectPaused(t.id, 'before withdraw');
    const res = await asAdmin((ctx) => approvals.withdraw(ctx, t.id, 'Fixed without the part'));
    expect(res.approvalStatus).toBe('withdrawn');
    expect(res.items.map((a) => a.status)).toEqual(['cancelled']);
    expect(res.items[0]!.comment).toBe('Fixed without the part');
    const r = await row(t.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('withdrawn');
    await expectRunning(t.id, 'after withdraw');
    expect((await outbox(t.id, 'approval.withdrawn')).map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);
    expect((await activities(t.id, 'approval'))[0]!.summary).toMatch(/^Approval request withdrawn by .*: Fixed without the part/);
    await expect(asAdmin((ctx) => approvals.withdraw(ctx, t.id))).rejects.toThrow(/No approval is pending/);
  });

  it('resolving or cancelling a ticket with a pending approval withdraws it and tells the approvers first', async () => {
    const a = await newTicket('incident', 'Resolved while waiting');
    await asAdmin((ctx) => approvals.requestApproval(ctx, a.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the part' }));
    await asAdmin((ctx) => resolveTicket(ctx, a.id, { resolutionNotes: 'Fixed another way' }));
    let r = await row(a.id);
    expect(r.approvalStatus).toBe('withdrawn');
    expect((await steps(a.id)).map((s) => s.status)).toEqual(['cancelled']);
    expect((await activities(a.id, 'approval'))[0]!.summary).toMatch(/Approval request withdrawn: the ticket was resolved/);
    expect((await outbox(a.id, 'approval.withdrawn')).map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);

    const c = await newTicket('incident', 'Cancelled while waiting');
    await asAdmin((ctx) => approvals.requestApproval(ctx, c.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the part' }));
    await asAdmin((ctx) => cancelTicket(ctx, c.id, { comment: 'Raised in error' }));
    r = await row(c.id);
    expect(r.approvalStatus).toBe('withdrawn');
    expect(r.statusId).toBe(st.cancelled);
    expect((await steps(c.id)).map((s) => s.status)).toEqual(['cancelled']);
    expect((await outbox(c.id, 'approval.withdrawn')).length).toBeGreaterThan(0);
  });
});

describe('the reminder and expiry job', () => {
  it('reminds the approvers once after approvals.reminder_hours, by hand at any time', async () => {
    const t = await newTicket('incident', 'Reminded');
    await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the part' }));
    // Not old enough: nothing.
    await approvals.remindAndExpire(new Date());
    expect((await steps(t.id))[0]!.remindedAt).toBeNull();
    const later = new Date(Date.now() + 25 * 3_600_000);
    const first = await approvals.remindAndExpire(later);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const [stepRow] = await steps(t.id);
    expect(stepRow!.remindedAt).not.toBeNull();
    const reminders = await outbox(t.id, 'approval.reminder');
    expect(reminders.map((o) => o.recipient)).toContain(`apr.admin.${S}@example.test`);
    // Once: a second sweep sends nothing more.
    await approvals.remindAndExpire(later);
    expect((await outbox(t.id, 'approval.reminder')).length).toBe(reminders.length);
    expect((await activities(t.id, 'approval'))[0]!.summary).toMatch(/^Approvers reminded after 24 hours/);
    // By hand, whatever the timing.
    const manual = await asAdmin((ctx) => approvals.remind(ctx, t.id));
    expect(manual.reminded).toBeGreaterThanOrEqual(1);
    expect((await outbox(t.id, 'approval.reminder')).length).toBeGreaterThan(reminders.length);
  });

  it('expires under return (back to work), reject (the type\'s rejection path) and none (reminders only)', async () => {
    const past = day(-10);
    const mk = async (type: 'incident' | 'request' | 'change', title: string) => {
      const t = await newTicket(type, title);
      await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: `Approve ${title}` }));
      await withSystem((tx) => tx.update(schema.approvals).set({ dueAt: past }).where(eq(schema.approvals.ticketId, t.id)));
      return t;
    };
    // return (the default): the ticket goes back to work, the steps expire, everyone is told.
    await setSetting('approvals.expiry_policy', 'return');
    const back = await mk('incident', 'Expired, returned');
    const res = await approvals.remindAndExpire(new Date());
    expect(res.expired).toBeGreaterThanOrEqual(1);
    let r = await row(back.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('expired');
    expect((await steps(back.id)).map((s) => s.status)).toEqual(['expired']);
    await expectRunning(back.id, 'expired and returned');
    const told = await outbox(back.id, 'approval.expired');
    expect(told.map((o) => o.recipient)).toEqual(expect.arrayContaining([`apr.admin.${S}@example.test`, `apr.user.${S}@example.test`]));
    expect((await activities(back.id, 'status'))[0]!.summary).toMatch(/Approval expired without a decision · back with the service desk as In Progress/);

    // reject: a request ends as Rejected, an incident returns to the engineer with the note.
    await setSetting('approvals.expiry_policy', 'reject');
    const req = await mk('request', 'Expired, rejected');
    const inc = await mk('incident', 'Expired, rejected incident');
    await approvals.remindAndExpire(new Date());
    r = await row(req.id);
    expect(r.statusId).toBe(st.rejected);
    expect(r.approvalStatus).toBe('rejected');
    expect((await steps(req.id)).map((s) => s.status)).toEqual(['expired']);
    r = await row(inc.id);
    expect(r.statusId).toBe(st.in_progress);
    expect(r.approvalStatus).toBe('rejected');
    expect((await comments(inc.id)).some((c) => /No decision by/.test(c.body) && !c.isInternal)).toBe(true);
    // A change under reject follows approvals.rejected_change (return by default): back to Draft, and the status row says so.
    const chg = await mk('change', 'Expired, returned change');
    await approvals.remindAndExpire(new Date());
    r = await row(chg.id);
    expect(r.statusId).toBe(st.draft);
    expect(r.approvalStatus).toBe('rejected');
    expect((await activities(chg.id, 'status'))[0]!.summary).toMatch(/^Approval expired without a decision · back to Draft to be revised$/);

    // none: reminders only; the overdue step stays pending.
    await setSetting('approvals.expiry_policy', 'none');
    const kept = await mk('incident', 'Expired, kept');
    await approvals.remindAndExpire(new Date());
    r = await row(kept.id);
    expect(r.statusId).toBe(st.awaiting_approval);
    expect(r.approvalStatus).toBe('pending');
    expect((await steps(kept.id)).map((s) => s.status)).toEqual(['pending']);
    await setSetting('approvals.expiry_policy', 'return');
  });
});

describe('inboxes and isolation', () => {
  it('the staff inbox and the portal inbox carry the purpose, the due date and who asked; another organisation never sees or decides the step', async () => {
    const t = await newTicket('incident', 'Inbox');
    const due = day(3);
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the inbox purpose', dueAt: due }));
    const step = firstStep(started.items);
    const mine = await asPortalAdmin((ctx) => approvals.listMine(ctx));
    const item = mine.items.find((a) => a.id === step.id)!;
    expect(item).toMatchObject({ purpose: 'Approve the inbox purpose', requestedByName: admin.name });
    expect(item.dueAt?.toISOString()).toBe(due.toISOString());
    const inbox = await asPortalAdmin((ctx) => portal.listPortalApprovals(ctx));
    expect(inbox.items.find((a) => a.id === step.id)).toMatchObject({ purpose: 'Approve the inbox purpose', requestedByName: admin.name });
    // The administrator of another organisation: not in the inbox, cannot decide, cannot read.
    const other = await asPortalAdminB((ctx) => portal.listPortalApprovals(ctx));
    expect(other.items.some((a) => a.id === step.id)).toBe(false);
    expect((await asPortalAdminB((ctx) => approvals.listMine(ctx))).items.some((a) => a.id === step.id)).toBe(false);
    await expect(asPortalAdminB((ctx) => portal.decidePortalApproval(ctx, t.id, step.id, 'approved', 'mine'))).rejects.toThrow(/not found|Forbidden|permission/i);
    await expect(asPortalAdminB((ctx) => approvals.decide(ctx, t.id, step.id, 'approved', 'mine'))).rejects.toThrow(/not found|Forbidden|permission/i);
    expect((await steps(t.id))[0]!.status).toBe('pending');
    // A customer_user of the organisation holds no portal:approve.
    await expect(asPortalUser((ctx) => portal.decidePortalApproval(ctx, t.id, step.id, 'approved', 'mine'))).rejects.toThrow(/portal:approve/);
  });
});

describe('the outcome reaches the customer when the ticket shows it; the desk keeps what is its own', () => {
  it('a CAB rejection of a customer-raised change tells the requester with the note; a CAB approval that moves a change to Approved too', async () => {
    const rejectedChange = await newTicket('change', 'Customer change, CAB says no');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, rejectedChange.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the firewall change' }));
    await asManager((ctx) => approvals.decide(ctx, rejectedChange.id, firstStep(started.items).id, 'rejected', 'Not during the freeze'));
    // Under the default `return` the change goes back to Draft with the note: the requester is told of the return (the outcome shows on the ticket).
    expect((await row(rejectedChange.id)).statusId).toBe(st.draft);
    expect((await activities(rejectedChange.id, 'status'))[0]!.summary).toMatch(/back to Draft to be revised/);
    const told = await outbox(rejectedChange.id, 'approval.rejected');
    expect(told.map((o) => o.recipient)).toContain(`apr.user.${S}@example.test`);
    expect(told.find((o) => o.recipient === `apr.user.${S}@example.test`)!.body).toMatch(/Not during the freeze/);
    expect((await comments(rejectedChange.id)).some((c) => c.body === 'Not during the freeze' && !c.isInternal)).toBe(true);

    const approvedChange = await newTicket('change', 'Customer change, CAB says yes');
    const two = await asAdmin((ctx) => approvals.requestApproval(ctx, approvedChange.id, { approvalWorkflowId: ids.cab, purpose: 'CAB approval for the switch change' }));
    const [s1, s2] = [...two.items].sort((a, b) => a.step - b.step);
    await asManager((ctx) => approvals.decide(ctx, approvedChange.id, s1!.id, 'approved'));
    // A released internal step is no outcome: nothing to the requester yet.
    expect((await outbox(approvedChange.id, 'approval.approved')).length).toBe(0);
    await asManager((ctx) => approvals.decide(ctx, approvedChange.id, s2!.id, 'approved', 'Scheduled for Saturday'));
    expect((await row(approvedChange.id)).statusId).toBe(st.approved);
    expect((await outbox(approvedChange.id, 'approval.approved')).map((o) => o.recipient)).toContain(`apr.user.${S}@example.test`);
  });

  it('withdraw keeps the reason out of the conversation and sends the requester one message', async () => {
    const t = await newTicket('incident', 'Withdrawn quietly');
    await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the quote' }));
    await asAdmin((ctx) => approvals.withdraw(ctx, t.id, 'Account on hold, keep the quote back'));
    expect((await row(t.id)).statusId).toBe(st.in_progress);
    expect((await comments(t.id)).some((c) => /keep the quote back/.test(c.body))).toBe(false);
    expect((await outbox(t.id, 'ticket.resumed')).length).toBe(0);
    expect((await outbox(t.id, 'approval.withdrawn')).map((o) => o.recipient)).toEqual(expect.arrayContaining([`apr.admin.${S}@example.test`, `apr.user.${S}@example.test`]));
    expect((await activities(t.id, 'status'))[0]!.summary).toMatch(/^Approval request withdrawn by .*: Account on hold, keep the quote back · back with the service desk as In Progress/);
    // An internal approver: the reason never leaves the desk.
    const i = await newTicket('incident', 'Withdrawn internally');
    await asAdmin((ctx) => approvals.requestApproval(ctx, i.id, { approver: { kind: 'role', ref: 'service_manager' }, purpose: 'Approve the overtime' }));
    await asAdmin((ctx) => approvals.withdraw(ctx, i.id, 'Customer is behind on payment'));
    expect((await comments(i.id)).some((c) => /behind on payment/.test(c.body))).toBe(false);
    expect((await activities(i.id)).filter((a) => a.customerVisible && /behind on payment/.test(a.summary)).length).toBe(0);
    expect((await outbox(i.id, 'approval.withdrawn')).map((o) => o.recipient)).not.toContain(`apr.user.${S}@example.test`);
    expect((await outbox(i.id, 'ticket.resumed')).length).toBe(0);
  });

  it('an approver named by anything but an id, and a second request while one is pending, are request errors', async () => {
    const t = await newTicket('incident', 'Bad refs');
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin', ref: 'manish' }, purpose: 'Approve this' }))).rejects.toThrow(/Name the administrator by id/);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'user', ref: 'manish@example.test' }, purpose: 'Approve this' }))).rejects.toThrow(/Name the user by id/);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'team', ref: 'NOC' }, purpose: 'Approve this' }))).rejects.toThrow(/Name the team by id/);
    expect((await steps(t.id)).length).toBe(0);
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve this' }));
    // The default due date is the end of a calendar day (UTC), approvals.default_due_days from today.
    expect(started.items[0]!.dueAt?.toISOString()).toMatch(/T23:59:59\.999Z$/);
    expect(started.items[0]!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    await expect(asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve this again' }))).rejects.toThrow(/already pending .*; withdraw it/);
    expect((await steps(t.id)).map((a) => a.status)).toEqual(['pending']);
  });

  it('a decision leaves a wait entered by hand untouched and still posts the note', async () => {
    const t = await newTicket('incident', 'Moved to the supplier while waiting');
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the part' }));
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!, pendingReason: 'ISP case 4411' }));
    await asPortalAdmin((ctx) => approvals.decide(ctx, t.id, firstStep(started.items).id, 'approved', 'Go ahead'));
    let r = await row(t.id);
    expect(r.statusId).toBe(st.pending_vendor);
    expect(r.pendingReason).toBe('ISP case 4411');
    expect(r.approvalStatus).toBe('approved');
    const p = await newTicket('problem', 'Rejected while with the supplier');
    const begun = await asAdmin((ctx) => approvals.requestApproval(ctx, p.id, { approver: { kind: 'customer_admin' }, purpose: 'Approve the workaround' }));
    await asAdmin((ctx) => changeStatus(ctx, p.id, { statusId: st.pending_vendor!, pendingReason: 'Vendor case 7' }));
    await asPortalAdmin((ctx) => approvals.decide(ctx, p.id, firstStep(begun.items).id, 'rejected', 'Not that workaround'));
    r = await row(p.id);
    expect(r.statusId).toBe(st.pending_vendor);
    expect(r.approvalStatus).toBe('rejected');
    expect((await comments(p.id)).some((c) => c.body === 'Not that workaround' && !c.isInternal)).toBe(true);
  });

  it('a released step is pending since its release and its request names the person who asked', async () => {
    const t = await newTicket('incident', 'Released later');
    const started = await asManager((ctx) => approvals.requestApproval(ctx, t.id, { approvalWorkflowId: ids.mixed, purpose: 'Approve the out-of-hours work' }));
    const [step1, step2] = [...started.items].sort((a, b) => a.step - b.step);
    await withSystem((tx) => tx.update(schema.approvals).set({ createdAt: sql`now() - interval '30 hours'` }).where(eq(schema.approvals.ticketId, t.id)));
    await approvals.remindAndExpire(new Date());
    expect((await steps(t.id)).find((s) => s.id === step1!.id)!.remindedAt).not.toBeNull();
    expect((await steps(t.id)).find((s) => s.id === step2!.id)!.remindedAt).toBeNull();
    await asAdmin((ctx) => approvals.decide(ctx, t.id, step1!.id, 'approved', 'Fine'));
    // Released just now: the sweep leaves the administrators alone although the row is thirty hours old.
    await approvals.remindAndExpire(new Date());
    expect((await steps(t.id)).find((s) => s.id === step2!.id)!.remindedAt).toBeNull();
    const asked = (await outbox(t.id, 'approval.requested')).filter((o) => o.recipient === `apr.admin.${S}@example.test`);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.find((o) => o.channel === 'email')!.body).toMatch(/by Sana Manager/);
    // A day after the release the administrators are reminded.
    await withSystem((tx) => tx.update(schema.approvals).set({ decidedAt: sql`now() - interval '25 hours'` }).where(eq(schema.approvals.id, step1!.id)));
    await approvals.remindAndExpire(new Date());
    expect((await steps(t.id)).find((s) => s.id === step2!.id)!.remindedAt).not.toBeNull();
  });
});
