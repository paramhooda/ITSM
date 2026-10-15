/**
 * The ticket lifecycle on ITIL (DB-backed). A wait (a pending status that is not
 * marked wait: false) can only be entered with a reason and a party; the transition
 * matrix refuses nonsense moves on every path; the pending block is written on entry,
 * rewritten on a wait-to-wait move and cleared on exit; the timeline keeps the reason
 * the engineer kept internal away from the customer; the notifications say "we need
 * something from you" rather than an internal status; a customer's reply ends a
 * customer reply wait and nothing else; the seed upgrade backfills tickets that
 * entered a wait before reasons were recorded.
 * Run with the dev environment sourced: npx vitest run test/lifecycle.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { TRANSITION_PROFILES, TRANSITION_PROFILE_KEYS, type StatusCategory } from '@itsm/shared';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { config } from '../src/config';
import { createTicket, changeStatus, cancelTicket, reopenTicket, resolveTicket, getTicket, bulkAction } from '../src/modules/tickets/service';
import { addComment, timeline } from '../src/modules/tickets/activity';
import { changeStatusCore, resumeFromPending } from '../src/modules/tickets/status';
import { requestApproval, decide } from '../src/modules/tickets/approvals';
import { applyTicketUpgrades, applyOptionUpgrades } from '../src/seed/upgrades';
import { withSetting } from './_settings';
import { toolByName } from '../src/modules/ai/tools';
import { compactDetail } from '../src/modules/ai/helpers';
import type { PreviewDetail } from '../src/modules/ai/tools/types';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-lifecycle-${S}` };
const ids = { customer: '', site: '', service: '', contract: '', adminUser: '', portalUser: '', portalAdmin: '', commenter: '', workflow: '' };
const st: Record<string, { id: string; label: string }> = {};
let admin: Principal;
let portal: Principal;
let portalAdmin: Principal;
let commenter: Principal;
const tickets: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, meta, fn);
const asPortalAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalAdmin, meta, fn);
const asCommenter = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(commenter, meta, fn);

async function option(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id, label: schema.configOptions.label }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`status ${key} missing (seed not applied?)`);
  return row;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing`);
  return row.id;
}
const row = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1))[0]!);
const slas = (id: string) => withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, id)));
const activities = (id: string, type: string) => withSystem((tx) => tx.select().from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, id), eq(schema.ticketActivities.activityType, type))).orderBy(desc(schema.ticketActivities.createdAt)));
const comments = (id: string) => withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, id)).orderBy(desc(schema.ticketComments.createdAt)));
const outbox = (id: string, event: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.entityId, id), eq(schema.notificationOutbox.event, event))));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function newIncident(title: string, opts: { requesterUserId?: string } = {}) {
  const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, serviceId: ids.service, title: `${title} ${S}`, description: 'lifecycle', requesterUserId: opts.requesterUserId ?? ids.portalUser }));
  tickets.push(t.id);
  return t;
}
/** Puts a ticket straight into a status (bypassing the rules) so a transition can be tried from it. */
async function force(id: string, key: string, pending?: { waitingOn: string; reason: string }) {
  await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st[key]!.id, pendingWaitingOn: pending?.waitingOn ?? null, pendingReason: pending?.reason ?? null, pendingReasonVisible: pending ? false : null }).where(eq(schema.tickets.id, id)));
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!adm) throw new Error('admin user missing (seed not applied?)');
    ids.adminUser = adm.id;
    for (const k of ['new', 'in_progress', 'pending_customer', 'pending_vendor', 'pending_change', 'on_hold', 'awaiting_approval', 'resolved', 'closed', 'cancelled', 'review', 'in_fulfilment', 'draft', 'implementing']) st[k] = await option(tx, k);
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `LC${S}`.toUpperCase(), name: `Lifecycle Customer ${S}` }).returning();
    ids.customer = c.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site.id;
    const [svc] = await tx.insert(schema.services).values({ key: `lc_svc_${S}`, name: `Lifecycle Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: c.id, number: `LC-${S}`, name: `Lifecycle AMC ${S}`, status: 'active', startDate: day(-10), endDate: day(355), slaPolicyId: policy?.id ?? null }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: c.id, serviceId: svc.id });
    await tx.insert(schema.scopeItems).values({ contractId: contract.id, customerId: c.id, serviceId: svc.id, name: 'Everything', classification: 'in_scope' });
    const [pu] = await tx.insert(schema.users).values({ email: `lc.user.${S}@example.test`, name: 'Ravi Requester', userType: 'customer', customerId: c.id, status: 'active' }).returning();
    const [pa] = await tx.insert(schema.users).values({ email: `lc.admin.${S}@example.test`, name: 'Meera Approver', userType: 'customer', customerId: c.id, status: 'active' }).returning();
    ids.portalUser = pu.id;
    ids.portalAdmin = pa.id;
    await tx.insert(schema.userRoles).values([
      { userId: pu.id, roleId: await roleId(tx, 'customer_user'), customerId: c.id },
      { userId: pa.id, roleId: await roleId(tx, 'customer_admin'), customerId: c.id },
    ]);
    // A staff member who may comment but not update tickets (the composer's reply-and-wait needs tickets:update).
    const [role] = await tx.insert(schema.roles).values({ key: `lc_commenter_${S}`, name: 'Commenter', userType: 'msp' }).returning();
    await tx.insert(schema.rolePermissions).values(['tenant:all', 'tickets:read', 'tickets:comment', 'tickets:work_notes'].map((permission) => ({ roleId: role.id, permission })));
    const [cu] = await tx.insert(schema.users).values({ email: `lc.commenter.${S}@example.test`, name: 'Cal Commenter', userType: 'msp', status: 'active' }).returning();
    ids.commenter = cu.id;
    await tx.insert(schema.userRoles).values({ userId: cu.id, roleId: role.id });
    const [wf] = await tx.insert(schema.approvalWorkflows).values({ name: `Customer sign-off ${S}`, steps: [{ name: 'Customer approval', approverType: 'customer_admin' }], isActive: true }).returning();
    ids.workflow = wf.id;
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portal = (await loadPrincipal(ids.portalUser))!;
  portalAdmin = (await loadPrincipal(ids.portalAdmin))!;
  commenter = (await loadPrincipal(ids.commenter))!;
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets));
    await tx.delete(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, ids.workflow));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.portalUser, ids.portalAdmin, ids.commenter]));
    await tx.delete(schema.roles).where(eq(schema.roles.key, `lc_commenter_${S}`));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

const BY_CATEGORY: Record<StatusCategory, string> = { new: 'new', open: 'in_progress', pending: 'pending_customer', resolved: 'resolved', closed: 'closed', cancelled: 'cancelled' };

describe('the transition matrix', () => {
  /** Every pair of categories through changeStatusCore under one profile: the table's pairs pass, every other pair is refused naming both statuses. */
  async function runMatrix(ticketId: string, profile: (typeof TRANSITION_PROFILE_KEYS)[number]) {
    const table = TRANSITION_PROFILES[profile];
    const cats = Object.keys(table) as StatusCategory[];
    for (const from of cats) {
      for (const to of cats) {
        if (from === to && from !== 'pending') continue;
        const fromKey = BY_CATEGORY[from];
        const toKey = BY_CATEGORY[to];
        await force(ticketId, fromKey, from === 'pending' ? { waitingOn: 'customer', reason: 'earlier' } : undefined);
        const allowed = table[from].includes(to);
        const attempt = asAdmin(async (ctx) => {
          const [cur] = await ctx.tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
          const [opt] = await ctx.tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, st[toKey]!.id));
          return changeStatusCore(ctx, cur!, opt!, { pendingReason: 'matrix', silent: true });
        });
        if (allowed) {
          const res = await attempt;
          expect(res.statusId, `${profile}: ${from} → ${to}`).toBe(st[toKey]!.id);
        } else {
          await expect(attempt, `${profile}: ${from} → ${to}`).rejects.toThrow(new RegExp(`cannot move from ${st[fromKey]!.label} to ${st[toKey]!.label}`));
        }
      }
    }
  }
  const move = (id: string, key: string, extra: Record<string, unknown> = {}) => asAdmin((ctx) => changeStatus(ctx, id, { statusId: st[key]!.id, ...extra }));

  it('strict: the shipped matrix, once per pair; New cannot close, Resolved can', async () => {
    const t = await newIncident('Matrix strict');
    await withSetting('tickets.transition_rules', 'strict', async () => {
      await runMatrix(t.id, 'strict');
      await force(t.id, 'new');
      await expect(move(t.id, 'closed')).rejects.toThrow(/cannot move from New to Closed/);
      await force(t.id, 'resolved');
      expect((await move(t.id, 'closed')).statusId).toBe(st.closed!.id);
    });
  });

  it('standard (the default): any move among new, open, pending and resolved; closed and cancelled come back to work only', async () => {
    const t = await newIncident('Matrix standard');
    expect((await withSystem((tx) => tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'tickets.transition_rules'))))[0]?.value).toBe('standard');
    await runMatrix(t.id, 'standard');
    await force(t.id, 'new');
    expect((await move(t.id, 'closed')).statusId).toBe(st.closed!.id);
    await force(t.id, 'pending_customer', { waitingOn: 'customer', reason: 'x' });
    expect((await move(t.id, 'closed')).statusId).toBe(st.closed!.id);
    await force(t.id, 'in_progress');
    expect((await move(t.id, 'new')).statusId).toBe(st.new!.id);
    await force(t.id, 'resolved');
    expect((await move(t.id, 'pending_customer', { pendingReason: 'one more thing' })).statusId).toBe(st.pending_customer!.id);
    await force(t.id, 'closed');
    await expect(move(t.id, 'pending_customer', { pendingReason: 'x' })).rejects.toThrow(/cannot move from Closed to Pending Customer/);
    await force(t.id, 'cancelled');
    await expect(move(t.id, 'resolved', { resolutionNotes: 'x' })).rejects.toThrow(/cannot move from Cancelled to Resolved/);
    // A malformed value is read as the default.
    await withSetting('tickets.transition_rules', 'whatever', async () => {
      await force(t.id, 'new');
      expect((await move(t.id, 'closed')).statusId).toBe(st.closed!.id);
    });
  });

  it('loose: only Closed is final', async () => {
    const t = await newIncident('Matrix loose');
    await withSetting('tickets.transition_rules', 'loose', async () => {
      await runMatrix(t.id, 'loose');
      await force(t.id, 'cancelled');
      expect((await move(t.id, 'resolved', { resolutionNotes: 'raised in error, then fixed' })).statusId).toBe(st.resolved!.id);
      await force(t.id, 'closed');
      await expect(move(t.id, 'resolved', { resolutionNotes: 'x' })).rejects.toThrow(/cannot move from Closed to Resolved/);
    });
  });

  it('the flow-set exemption: the approvals service returns a rejected change to Draft under strict, while a person\'s move back to Draft is refused', async () => {
    const c = await asAdmin((ctx) => createTicket(ctx, { type: 'change', customerId: ids.customer, title: `Flow-set change ${S}`, description: 'exempt', requesterUserId: ids.portalUser }));
    tickets.push(c.id);
    await withSetting('tickets.transition_rules', 'strict', async () => {
      await force(c.id, 'implementing');
      await expect(move(c.id, 'draft')).rejects.toThrow(/cannot move from Implementing to Draft/);
      const started = await asAdmin((ctx) => requestApproval(ctx, c.id, { approvalWorkflowId: ids.workflow, purpose: 'Approval for the flow-set test' }));
      expect((await row(c.id)).statusId).toBe(st.awaiting_approval!.id);
      // Awaiting Approval (pending) → Draft (new) is not in the strict table; the service's own move passes.
      await asPortalAdmin((ctx) => decide(ctx, c.id, started.items[0]!.id, 'rejected', 'Revise the plan'));
      const r = await row(c.id);
      expect(r.statusId).toBe(st.draft!.id);
      expect(r.approvalStatus).toBe('rejected');
      // The person is still held to the profile: Draft (new) → Pending Customer (pending) is allowed, Draft → Closed is not.
      await expect(move(c.id, 'closed')).rejects.toThrow(/cannot move from Draft to Closed/);
    });
  });
});

describe('entering a wait', () => {
  it('needs a reason for a customer wait by default (on the status endpoint, in bulk, through the assistant and on reply-and-wait); a supplier wait passes without one, with no reason stored and no comment posted', async () => {
    const t = await newIncident('Reason rule');
    await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id }))).rejects.toThrow(/A reason is required to put .* on hold/);
    const bulk = await asAdmin((ctx) => bulkAction(ctx, { ids: [t.id], action: 'status', payload: { statusId: st.pending_customer!.id } }));
    expect(bulk.failed).toBe(1);
    expect(bulk.results[0]!.error).toMatch(/reason is required/);
    const tool = toolByName('set_status')!;
    await expect(asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'pending_customer' }))).rejects.toThrow(/reason is required/);
    await expect(asAdmin((ctx) => tool.run(ctx, { ticket: t.number, status: 'pending_customer' }))).rejects.toThrow(/reason is required/);
    await expect(asAdmin((ctx) => addComment(ctx, t.id, { kind: 'comment', body: '   ', then: { statusId: st.pending_customer!.id } }))).rejects.toThrow();
    expect((await row(t.id)).statusId).toBe(st.new!.id);
    // A supplier wait: the party is recorded, the reason is null, nothing is posted, the staff row reads the label alone.
    const before = (await comments(t.id)).length;
    const v = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id }));
    expect(v.statusId).toBe(st.pending_vendor!.id);
    expect(v.pendingWaitingOn).toBe('vendor');
    expect(v.pendingReason).toBeNull();
    expect((await comments(t.id)).length).toBe(before);
    const rows = await activities(t.id, 'pending');
    expect(rows.find((r) => !r.customerVisible)!.summary).toBe('Waiting on a supplier or third party');
    expect(rows.find((r) => r.customerVisible)!.summary).toBe('Waiting on a supplier or third party');
    const staff = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(staff.pending).toMatchObject({ waitingOn: 'vendor', reason: null });
    // The bulk bar and the assistant pass the same way.
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    const ok = await asAdmin((ctx) => bulkAction(ctx, { ids: [t.id], action: 'status', payload: { statusId: st.pending_vendor!.id } }));
    expect(ok.failed).toBe(0);
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    const res = (await asAdmin((ctx) => tool.run(ctx, { ticket: t.number, status: 'on_hold', waitingOn: 'agreement' }))) as { pending: { waitingOn: string; reason: string | null } };
    expect(res.pending).toMatchObject({ waitingOn: 'agreement', reason: null });
  });

  it('tickets.pending_reason_required = always refuses every wait without a reason; never accepts every wait without one', async () => {
    const t = await newIncident('Reason modes');
    await withSetting('tickets.pending_reason_required', 'always', async () => {
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id }))).rejects.toThrow(/A reason is required to put .* on hold/);
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id }))).rejects.toThrow(/A reason is required to put .* on hold/);
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, waitingOn: 'internal' }))).rejects.toThrow(/A reason is required to put .* on hold/);
      await expect(asAdmin((ctx) => toolByName('set_status')!.preview!(ctx, { ticket: t.number, status: 'pending_vendor' }))).rejects.toThrow(/reason is required/);
      expect((await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'with the ISP' }))).pendingReason).toBe('with the ISP');
    });
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    await withSetting('tickets.pending_reason_required', 'never', async () => {
      const c = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id }));
      expect(c).toMatchObject({ pendingWaitingOn: 'customer', pendingReason: null, pendingReasonVisible: true });
      // The customer is still told the ticket waits on them, without a reason.
      const mail = (await outbox(t.id, 'ticket.pending')).filter((r) => r.recipient === `lc.user.${S}@example.test`);
      expect(mail.length).toBeGreaterThan(0);
      expect(mail[mail.length - 1]!.body).toContain('We need something from you');
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
      expect((await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id }))).pendingReason).toBeNull();
      // The On Hold party choice stays a rule whatever the setting.
      await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id }))).rejects.toThrow(/Say who the hold waits on/);
    });
  });

  it('Awaiting Approval by hand is refused; a post-implementation review is not a wait and needs nothing', async () => {
    const t = await newIncident('Guards');
    await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.awaiting_approval!.id, pendingReason: 'please' }))).rejects.toThrow();
    const c = await asAdmin((ctx) => createTicket(ctx, { type: 'change', customerId: ids.customer, title: `PIR change ${S}`, description: 'review' }));
    tickets.push(c.id);
    await force(c.id, 'implementing');
    const reviewed = await asAdmin((ctx) => changeStatus(ctx, c.id, { statusId: st.review!.id }));
    expect(reviewed.statusId).toBe(st.review!.id);
    expect(reviewed.pendingWaitingOn).toBeNull();
    expect(reviewed.pendingReason).toBeNull();
    const detail = await asAdmin((ctx) => getTicket(ctx, c.id));
    expect(detail.pending).toBeNull();
    expect(detail.status?.wait).toBe(false);
    expect((await slas(c.id)).every((r) => r.state !== 'paused')).toBe(true);
  });

  it('sets the seven columns, derives the party from the key, refuses On Hold without a choice, rewrites on a same-status call and clears on exit', async () => {
    const t = await newIncident('Columns');
    const when = new Date('2030-02-01T00:00:00Z');
    const a = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'ISP is replacing the line card', pendingReference: 'ISP-9', expectedAt: when }));
    expect(a).toMatchObject({ pendingReason: 'ISP is replacing the line card', pendingWaitingOn: 'vendor', pendingReference: 'ISP-9', pendingReasonVisible: false, pendingSetBy: ids.adminUser });
    expect(a.pendingExpectedAt?.toISOString()).toBe(when.toISOString());
    expect(a.pendingSetAt).not.toBeNull();
    // A same-status call with a reason rewrites the wait rather than being a no-op.
    const b = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'ISP confirmed the part is on its way', pendingReference: 'ISP-9b' }));
    expect(b.pendingReason).toBe('ISP confirmed the part is on its way');
    expect(b.pendingReference).toBe('ISP-9b');
    expect(b.pendingExpectedAt).toBeNull();
    // A rewrite keeps who put the ticket on hold and since when.
    expect(b.pendingSetAt?.toISOString()).toBe(a.pendingSetAt?.toISOString());
    expect(b.pendingSetBy).toBe(a.pendingSetBy);
    // A same-status call without a reason is still a no-op.
    const same = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id }));
    expect(same.pendingReason).toBe('ISP confirmed the part is on its way');
    // A rewrite that gives only the expected date keeps the stored reason (the field was not sent); an explicit null clears it.
    const dated = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, expectedAt: when }));
    expect(dated.pendingReason).toBe('ISP confirmed the part is on its way');
    expect(dated.pendingExpectedAt?.toISOString()).toBe(when.toISOString());
    const cleared = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: null, expectedAt: when }));
    expect(cleared.pendingReason).toBeNull();
    const again = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'ISP confirmed the part is on its way' }));
    expect(again.pendingReason).toBe('ISP confirmed the part is on its way');
    // Wait to wait: the party moves with the status.
    await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, pendingReason: 'parked' }))).rejects.toThrow(/Say who the hold waits on/);
    const c = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, pendingReason: 'parked as agreed', waitingOn: 'agreement' }));
    expect(c.pendingWaitingOn).toBe('agreement');
    const d = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_change!.id, pendingReason: 'CHG-1 scheduled Saturday' }));
    expect(d.pendingWaitingOn).toBe('change');
    const e = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    for (const k of ['pendingReason', 'pendingWaitingOn', 'pendingExpectedAt', 'pendingReference', 'pendingReasonVisible', 'pendingSetBy', 'pendingSetAt'] as const) expect(e[k], k).toBeNull();
    expect((await activities(t.id, 'pending'))[0]!.summary).toMatch(/^Resumed · by /);
  });
});

describe('the fence between the customer and the desk', () => {
  it('writes a customer row without the hidden reason and a staff row with it; posts the reason as a reply or a work note; an internal hold writes only internal rows', async () => {
    const t = await newIncident('Fence');
    const secret = `their engineer Bob is on leave ${S}`;
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: secret, tellCustomer: false, pendingReference: 'ACME-77', expectedAt: new Date('2030-03-10T00:00:00Z') }));
    let rows = await activities(t.id, 'pending');
    const customerRow = rows.find((r) => r.customerVisible)!;
    const staffRow = rows.find((r) => !r.customerVisible)!;
    expect(customerRow.summary).toBe('Waiting on a supplier or third party · expected 10 Mar 2030');
    expect(customerRow.data).toMatchObject({ waitingOn: 'vendor', visible: false });
    expect(JSON.stringify(customerRow.data)).not.toContain(secret);
    expect(JSON.stringify(customerRow.data)).not.toContain('ACME-77');
    expect(staffRow.summary).toContain(secret);
    expect(staffRow.summary).toContain('ref ACME-77');
    expect(staffRow.data).toMatchObject({ waitingOn: 'vendor', reason: secret, reference: 'ACME-77' });
    let cs = await comments(t.id);
    expect(cs[0]).toMatchObject({ body: secret, isInternal: true, kind: 'work_note' });
    // The customer timeline never carries the secret.
    const portalView = await asPortal((ctx) => timeline(ctx, t.id));
    expect(JSON.stringify(portalView.items)).not.toContain(secret);
    expect(portalView.items.some((i) => i.type === 'pending' && i.summary === customerRow.summary)).toBe(true);
    const staffView = await asAdmin((ctx) => timeline(ctx, t.id));
    expect(staffView.items.filter((i) => i.type === 'pending').length).toBe(2);

    // Tell the customer: the reason is a reply they can read and the customer row carries it.
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id, pendingReason: 'Please confirm the site contact', tellCustomer: true }));
    rows = await activities(t.id, 'pending');
    expect(rows.find((r) => r.customerVisible)!.summary).toBe('We need something from you · Please confirm the site contact');
    cs = await comments(t.id);
    expect(cs[0]).toMatchObject({ body: 'Please confirm the site contact', isInternal: false, kind: 'comment' });
    expect((await row(t.id)).pendingReasonVisible).toBe(true);

    // postReason: false posts nothing (the caller's own comment is the reason).
    const before = (await comments(t.id)).length;
    await asAdmin(async (ctx) => {
      const [cur] = await ctx.tx.select().from(schema.tickets).where(eq(schema.tickets.id, t.id));
      const [opt] = await ctx.tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, st.pending_vendor!.id));
      await changeStatusCore(ctx, cur!, opt!, { pendingReason: 'quiet', postReason: false, silent: true });
    });
    expect((await comments(t.id)).length).toBe(before);

    // An internal hold: the status row and the pending row are internal; the customer sees no wait.
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, pendingReason: 'Waiting for the storage team', waitingOn: 'internal' }));
    rows = await activities(t.id, 'pending');
    expect(rows[0]!.customerVisible).toBe(false);
    expect(rows[0]!.summary).toContain('On hold (internal)');
    const statusRows = await activities(t.id, 'status');
    expect(statusRows[0]!.summary).toMatch(/to On Hold/);
    expect(statusRows[0]!.customerVisible).toBe(false);
    const portalAfter = await asPortal((ctx) => timeline(ctx, t.id));
    expect(JSON.stringify(portalAfter.items)).not.toMatch(/On Hold|storage team|internal/);
    // Leaving the internal hold is internal as well.
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    expect((await activities(t.id, 'status'))[0]!.customerVisible).toBe(false);
  });

  it('getTicket returns the four-key customer shape (reason null when hidden) and null for an internal hold; the staff block carries everything', async () => {
    const t = await newIncident('Shapes');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'hidden from the customer', pendingReference: 'REF-1' }));
    let mine = await asPortal((ctx) => getTicket(ctx, t.id));
    expect(mine.pending).toEqual({ waitingOn: 'vendor', waitingOnLabel: 'Waiting on a supplier or third party', reason: null, expectedAt: null });
    expect(Object.keys(mine.pending!).sort()).toEqual(['expectedAt', 'reason', 'waitingOn', 'waitingOnLabel']);
    expect('pendingReference' in mine).toBe(false);
    expect('pendingReason' in mine).toBe(false);
    const staff = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(staff.pending).toMatchObject({ waitingOn: 'vendor', waitingOnLabel: 'Waiting on a supplier or third party', reason: 'hidden from the customer', reference: 'REF-1', reasonVisible: false, setBy: { id: ids.adminUser } });
    expect(staff.pending && 'slaPausedSince' in staff.pending && staff.pending.slaPausedSince).toBeTruthy();
    expect(compactDetail({ user: admin } as unknown as Ctx, staff).pending).toMatchObject({ waitingOn: 'vendor', reason: 'hidden from the customer' });

    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id, pendingReason: 'Send the photo of the label' }));
    mine = await asPortal((ctx) => getTicket(ctx, t.id));
    expect(mine.pending).toEqual({ waitingOn: 'customer', waitingOnLabel: 'We need something from you', reason: 'Send the photo of the label', expectedAt: null });

    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, pendingReason: 'capacity', waitingOn: 'internal' }));
    mine = await asPortal((ctx) => getTicket(ctx, t.id));
    expect(mine.pending).toBeNull();
    const staffHold = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(staffHold.pending).toMatchObject({ waitingOn: 'internal', waitingOnLabel: 'On hold (internal)', slaPausedSince: null });
  });
});

describe('notifications', () => {
  it('queues ticket.pending with the customer label (the reason only when shown), ticket.resumed on resume, and nothing to the customer for an internal hold', async () => {
    const t = await newIncident('Notify');
    const me = `lc.user.${S}@example.test`;
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id, pendingReason: 'We need the serial number', tellCustomer: true }));
    let rows = await outbox(t.id, 'ticket.pending');
    expect(rows.some((r) => r.recipient === me)).toBe(true);
    expect(rows.find((r) => r.recipient === me)!.body).toContain('We need something from you');
    expect(rows.find((r) => r.recipient === me)!.body).toContain('We need the serial number');
    expect(await outbox(t.id, 'ticket.status_changed')).toEqual([]);

    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    rows = await outbox(t.id, 'ticket.resumed');
    expect(rows.some((r) => r.recipient === me)).toBe(true);
    expect(rows.find((r) => r.recipient === me)!.body).toContain('back with the service desk');

    const secret = `vendor engineer unreachable ${S}`;
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: secret, tellCustomer: false }));
    rows = await outbox(t.id, 'ticket.pending');
    const vendorMail = rows.filter((r) => r.recipient === me && r.body.includes('supplier'));
    expect(vendorMail.length).toBeGreaterThan(0);
    for (const r of vendorMail) expect(r.body).not.toContain(secret);

    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.on_hold!.id, pendingReason: 'capacity', waitingOn: 'internal' }));
    const all = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.entityId, t.id)));
    const toCustomer = all.filter((r) => r.recipient === me);
    expect(toCustomer.some((r) => /On Hold|capacity/.test(`${r.subject} ${r.body}`))).toBe(false);
    expect(all.filter((r) => r.event === 'ticket.status_changed').every((r) => r.recipient !== me)).toBe(true);
  });
});

describe('resuming', () => {
  it('a customer comment resumes a customer reply wait, not a supplier wait and not an approval wait addressed to the customer', async () => {
    const t = await newIncident('Resume');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_vendor!.id, pendingReason: 'with the supplier' }));
    await asPortal((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Any update?' }));
    expect((await row(t.id)).statusId).toBe(st.pending_vendor!.id);

    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.pending_customer!.id, pendingReason: 'Need your approval of the quote' }));
    expect((await slas(t.id)).filter((r) => r.metric === 'resolution').every((r) => r.state === 'paused')).toBe(true);
    await asPortal((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Here it is' }));
    const back = await row(t.id);
    expect(back.statusId).toBe(st.in_progress!.id);
    expect(back.pendingWaitingOn).toBeNull();
    expect((await slas(t.id)).every((r) => r.state !== 'paused')).toBe(true);
    expect((await activities(t.id, 'status'))[0]!.summary).toMatch(/Customer replied · back with the service desk as In Progress/);

    // An approval wait addressed to the customer: the request awaits the customer's approval; their comment is a comment.
    const r = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, title: `Quote approval ${S}`, description: 'needs sign-off', requesterUserId: ids.portalUser }));
    tickets.push(r.id);
    await asAdmin((ctx) => requestApproval(ctx, r.id, { approvalWorkflowId: ids.workflow, purpose: 'Approval for the lifecycle test' }));
    let req = await row(r.id);
    expect(req.statusId).toBe(st.awaiting_approval!.id);
    expect(req.pendingWaitingOn).toBe('customer');
    expect(req.approvalStatus).toBe('pending');
    await asPortal((ctx) => addComment(ctx, r.id, { kind: 'comment', body: 'Our director is back on Monday' }));
    req = await row(r.id);
    expect(req.statusId).toBe(st.awaiting_approval!.id);
    expect(req.approvalStatus).toBe('pending');
    expect(await asPortal((ctx) => resumeFromPending(ctx, req, { trigger: 'customer_reply' }))).toBeNull();
    // The decision ends the wait through resumeFromPending.
    const [step] = await withSystem((tx) => tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, r.id), eq(schema.approvals.status, 'pending'))));
    const { decide } = await import('../src/modules/tickets/approvals');
    await asPortalAdmin((ctx) => decide(ctx, r.id, step!.id, 'approved', 'Go ahead'));
    req = await row(r.id);
    expect(req.statusId).toBe(st.in_fulfilment!.id);
    expect(req.approvalStatus).toBe('approved');
    expect(req.pendingWaitingOn).toBeNull();
    expect((await activities(r.id, 'status'))[0]!.summary).toMatch(/Approved by Meera Approver · back with the service desk/);
  });

  it('cancelling and reopening need no comment by default (the audit row and the reopen count carry the trace); a customer may still cancel their own new ticket', async () => {
    const t = await newIncident('Cancel default');
    const cancelled = await asAdmin((ctx) => cancelTicket(ctx, t.id, {}));
    expect(cancelled.statusId).toBe(st.cancelled!.id);
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, t.id), eq(schema.auditLog.action, 'ticket.cancel'))));
    expect(audit.length).toBe(1);
    const reopened = await asAdmin((ctx) => reopenTicket(ctx, t.id, {}));
    expect(reopened.reopenCount).toBe(1);
    expect((await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, t.id), eq(schema.auditLog.action, 'ticket.reopen'))))).length).toBe(1);
    expect((await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.cancelled!.id }))).statusId).toBe(st.cancelled!.id);
    expect((await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }))).reopenCount).toBe(2);
    const own = await asPortal((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Own ticket ${S}`, description: 'mine' }));
    tickets.push(own.id);
    expect((await asPortal((ctx) => cancelTicket(ctx, own.id, {}))).statusId).toBe(st.cancelled!.id);
  });

  it('tickets.cancel_comment_required and tickets.reopen_comment_required hold staff to a reason, never the customer', async () => {
    const t = await newIncident('Cancel required');
    await withSetting('tickets.cancel_comment_required', true, async () => {
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.cancelled!.id }))).rejects.toThrow(/reason is required to cancel/);
      await expect(asAdmin((ctx) => cancelTicket(ctx, t.id, {}))).rejects.toThrow(/reason is required to cancel/);
      const own = await asPortal((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Own ticket 2 ${S}`, description: 'mine' }));
      tickets.push(own.id);
      expect((await asPortal((ctx) => cancelTicket(ctx, own.id, {}))).statusId).toBe(st.cancelled!.id);
      expect((await asAdmin((ctx) => cancelTicket(ctx, t.id, { comment: 'Duplicate of another ticket' }))).statusId).toBe(st.cancelled!.id);
    });
    await withSetting('tickets.reopen_comment_required', true, async () => {
      await expect(asAdmin((ctx) => reopenTicket(ctx, t.id, {}))).rejects.toThrow(/reason is required to reopen/);
      await expect(asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }))).rejects.toThrow(/reason is required to reopen/);
      await expect(asAdmin((ctx) => toolByName('set_status')!.preview!(ctx, { ticket: t.number, status: 'in_progress' }))).rejects.toThrow(/reason is required to reopen/);
      const reopened = await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id, comment: 'It came back' }));
      expect(reopened.reopenCount).toBe(1);
      // A boolean written as text still counts.
      await asAdmin((ctx) => resolveTicket(ctx, t.id, { resolutionNotes: 'Fixed' }));
      await withSetting('tickets.reopen_comment_required', 'true', async () => {
        await expect(asAdmin((ctx) => reopenTicket(ctx, t.id, {}))).rejects.toThrow(/reason is required to reopen/);
      });
    });
  });
});

describe('reply and wait', () => {
  it('a reply with `then` moves the ticket with the reply as the reason (a work note stays internal); refused for a customer and for staff without tickets:update', async () => {
    const t = await newIncident('Then');
    await expect(asPortal((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'hi', then: { statusId: st.pending_customer!.id } }))).rejects.toThrow(/not available in the customer portal/);
    await expect(asCommenter((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'hi', then: { statusId: st.pending_customer!.id } }))).rejects.toThrow(/tickets:update/);
    expect((await comments(t.id)).length).toBe(0);
    const before = (await outbox(t.id, 'ticket.engineer_comment')).length;
    await asAdmin((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Could you send the config export? We need it to continue.', then: { statusId: st.pending_customer!.id, expectedAt: new Date('2030-04-01T00:00:00Z') } }));
    const after = await row(t.id);
    expect(after.statusId).toBe(st.pending_customer!.id);
    expect(after.pendingReason).toBe('Could you send the config export? We need it to continue.');
    expect(after.pendingReasonVisible).toBe(true);
    expect(after.pendingExpectedAt?.toISOString()).toBe('2030-04-01T00:00:00.000Z');
    // One reply, no extra reason comment; the customer hears of it once, as the reply.
    expect((await comments(t.id)).length).toBe(1);
    expect(await outbox(t.id, 'ticket.pending')).toEqual([]);
    const replies = await outbox(t.id, 'ticket.engineer_comment');
    expect(replies.length).toBeGreaterThan(before);
    expect(replies.some((r) => r.body.includes('The ticket now waits on a reply from the customer'))).toBe(true);
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    // `then` only puts a ticket on hold: resolving, closing or cancelling keep their own rules and permission.
    await expect(asAdmin((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'done', then: { statusId: st.resolved!.id } }))).rejects.toThrow(/only moves a ticket to a pending status/);
    await expect(asAdmin((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'done', then: { statusId: st.in_progress!.id } }))).rejects.toThrow(/only moves a ticket to a pending status/);
    expect((await row(t.id)).statusId).toBe(st.in_progress!.id);
    // A work note that puts the ticket on a customer wait still tells the requester the ticket waits on them, without the note's text.
    await asAdmin((ctx) => addComment(ctx, t.id, { kind: 'work_note', body: 'Chased the site contact by phone, no answer yet', then: { statusId: st.pending_customer!.id } }));
    const pendingRows = await outbox(t.id, 'ticket.pending');
    expect(pendingRows.length).toBeGreaterThan(0);
    expect(pendingRows.some((r) => r.body.includes('We need something from you'))).toBe(true);
    expect(pendingRows.some((r) => r.body.includes('Chased the site contact'))).toBe(false);
    expect((await row(t.id)).pendingReasonVisible).toBe(false);
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    await asAdmin((ctx) => addComment(ctx, t.id, { kind: 'work_note', body: 'Parked: waiting for the storage team to size the LUN', then: { statusId: st.on_hold!.id, waitingOn: 'internal' } }));
    const held = await row(t.id);
    expect(held.statusId).toBe(st.on_hold!.id);
    expect(held.pendingWaitingOn).toBe('internal');
    expect(held.pendingReasonVisible).toBe(false);
  });
});

describe('the assistant', () => {
  it('set_status previews the status, the reason, the clocks that pause and whether the customer is told; an internal hold keeps the clocks running', async () => {
    const t = await newIncident('Grady');
    const tool = toolByName('set_status')!;
    const p = (await asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'pending_customer', reason: 'needs the serial number', expectedAt: '2030-05-15' }))) as PreviewDetail;
    expect(p.text).toContain('Pending Customer');
    expect(p.lines).toEqual(expect.arrayContaining(['Status: New → Pending Customer', 'Waiting on the customer: needs the serial number', 'Expected by 15 May 2030', 'The customer is told: needs the serial number']));
    expect(p.lines!.some((l) => /^Resolution( and Restoration)? clocks? pauses?; the (response|acknowledgement)( and \w+)? clocks? keeps? running$/.test(l)), JSON.stringify(p.lines)).toBe(true);
    const hold = (await asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'on_hold', reason: 'capacity', waitingOn: 'internal' }))) as PreviewDetail;
    expect(hold.lines).toEqual(expect.arrayContaining(['Clocks keep running (internal hold)', 'The customer is not told (an internal hold is not shown in the portal)']));
    // A supplier wait without a reason is said, not refused, under the default; the clock line comes from the policy.
    const vendor = (await asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'pending_vendor' }))) as PreviewDetail;
    expect(vendor.lines).toEqual(expect.arrayContaining(['Waiting on a supplier or third party', 'No reason given (not required for a supplier wait; a customer wait needs one)']));
    expect(vendor.lines!.some((l) => /^Resolution( and Restoration)? clocks? pauses?/.test(l)), JSON.stringify(vendor.lines)).toBe(true);
    const req = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, title: `Approval by hand ${S}`, description: 'x' }));
    tickets.push(req.id);
    await expect(asAdmin((ctx) => tool.preview!(ctx, { ticket: req.number, status: 'awaiting_approval', reason: 'x' }))).rejects.toThrow(/request_approval/);
    // New → Closed is refused under strict only.
    await withSetting('tickets.transition_rules', 'strict', async () => {
      await expect(asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'closed' }))).rejects.toThrow(/cannot move from New to Closed/);
    });
    expect(((await asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'closed' }))) as PreviewDetail).lines).toContain('Status: New → Closed');
    const res = (await asAdmin((ctx) => tool.run(ctx, { ticket: t.number, status: 'pending_customer', reason: 'needs the serial number', expectedAt: '2030-05-15', notifyCustomer: true }))) as { status: string; pending: { waitingOn: string }; slas: { metric: string; state: string }[] };
    expect(res.status).toBe('Pending Customer');
    expect(res.pending.waitingOn).toBe('customer');
    expect(res.slas.find((s) => s.metric === 'resolution')?.state).toBe('paused');
    expect(res.slas.find((s) => s.metric === 'response')?.state).toBe('running');
    const resume = (await asAdmin((ctx) => tool.preview!(ctx, { ticket: t.number, status: 'in_progress' }))) as PreviewDetail;
    expect(resume.lines!.some((l) => /clocks? resumes? with the paused time credited/.test(l))).toBe(true);
    const detail = (await asAdmin((ctx) => toolByName('get_ticket')!.run(ctx, { ticket: t.number }))) as { pending?: { waitingOn: string; reason: string } };
    expect(detail.pending ?? (detail as { ticket?: { pending?: unknown } }).ticket?.pending).toBeTruthy();
  });
});

describe('the seed upgrades', () => {
  it('backfill the pending block of a ticket that entered a wait before reasons were recorded, once', async () => {
    const t = await newIncident('Legacy');
    await asAdmin((ctx) => changeStatus(ctx, t.id, { statusId: st.in_progress!.id }));
    await asAdmin((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Please confirm the delivery address.' }));
    // Simulate a row written before the column existed.
    await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.pending_customer!.id, pendingWaitingOn: null, pendingReason: null, pendingReasonVisible: null, pendingSetAt: null }).where(eq(schema.tickets.id, t.id)));
    await withSystem((tx) => tx.insert(schema.ticketActivities).values({ ticketId: t.id, customerId: ids.customer, activityType: 'status', summary: 'Status changed from In Progress to Pending Customer', data: {}, customerVisible: true, createdAt: new Date(Date.now() - 60_000) }));
    const n = await withSystem((tx) => applyTicketUpgrades(tx));
    expect(n).toBeGreaterThanOrEqual(1);
    const up = await row(t.id);
    expect(up.pendingWaitingOn).toBe('customer');
    expect(up.pendingReason).toBe('Please confirm the delivery address.');
    expect(up.pendingReasonVisible).toBe(true);
    expect(up.pendingSetAt).not.toBeNull();
    // Idempotent: a second run touches nothing, and the customer's reply still ends the wait.
    await withSystem((tx) => tx.update(schema.tickets).set({ pendingReason: 'kept' }).where(eq(schema.tickets.id, t.id)));
    await withSystem((tx) => applyTicketUpgrades(tx));
    expect((await row(t.id)).pendingReason).toBe('kept');
    await asPortal((ctx) => addComment(ctx, t.id, { kind: 'comment', body: 'Confirmed.' }));
    expect((await row(t.id)).statusId).toBe(st.in_progress!.id);
    // A legacy wait with no staff comment gets the fixed sentence, not shown to the customer.
    const u = await newIncident('Legacy quiet');
    await withSystem((tx) => tx.update(schema.tickets).set({ statusId: st.pending_vendor!.id }).where(eq(schema.tickets.id, u.id)));
    await withSystem((tx) => applyTicketUpgrades(tx));
    expect(await row(u.id)).toMatchObject({ pendingWaitingOn: 'vendor', pendingReason: 'Set before reasons were recorded', pendingReasonVisible: false });
    // The option upgrades are idempotent and leave a fresh seed alone.
    await withSystem((tx) => applyOptionUpgrades(tx));
    const [pc] = await withSystem((tx) => tx.select({ pausesSla: schema.configOptions.pausesSla }).from(schema.configOptions).where(eq(schema.configOptions.id, st.pending_change!.id)));
    expect(pc!.pausesSla).toBe(true);
    const [rv] = await withSystem((tx) => tx.select({ metadata: schema.configOptions.metadata }).from(schema.configOptions).where(eq(schema.configOptions.id, st.review!.id)));
    expect((rv!.metadata as { wait?: boolean }).wait).toBe(false);
    // Applied once: an administrator who turns the pause off afterwards keeps it off at the next start.
    await withSystem((tx) => tx.update(schema.configOptions).set({ pausesSla: false }).where(eq(schema.configOptions.id, st.pending_change!.id)));
    await withSystem((tx) => applyOptionUpgrades(tx));
    const [pc2] = await withSystem((tx) => tx.select({ pausesSla: schema.configOptions.pausesSla, metadata: schema.configOptions.metadata }).from(schema.configOptions).where(eq(schema.configOptions.id, st.pending_change!.id)));
    expect(pc2!.pausesSla).toBe(false);
    expect((pc2!.metadata as { upgrades?: string[] }).upgrades).toContain('pending_change_pauses');
    await withSystem((tx) => tx.update(schema.configOptions).set({ pausesSla: true }).where(eq(schema.configOptions.id, st.pending_change!.id)));
  });
});
