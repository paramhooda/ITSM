/**
 * Customer portal integration tests (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/portal.test.ts
 *
 * Two customers (A, B) with their own portal users; everything is exercised
 * through the portal service layer under the customer principals so tenant
 * isolation, permission limits and data shaping are verified end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import { createTicket, changeStatus, resolveTicket } from '@/modules/tickets/service';
import { addComment } from '@/modules/tickets/activity';
import * as portal from '@/modules/portal/service';
import { portalTicketStatsQuery } from '@/modules/portal/schemas';
import { pendingForPortal } from '@/modules/surveys/portal';
import { ValidationError } from '@/core/errors';
import { hashPassword } from '@/lib/crypto';
import { buildApp } from '@/core/app';

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const ids = {
  customerA: '',
  customerB: '',
  siteA: '',
  siteB: '',
  service: '',
  contract: '',
  catalogPlain: '',
  catalogApproval: '',
  userA: '',
  userB: '',
  ticketA: '',
  ticketB: '',
  approvalTicket: '',
  visitA: '',
  visitB: '',
  sourcePortal: '',
  adminUser: '',
};
let admin: Principal;
let portalA: Principal;
let portalB: Principal;
const createdTickets: string[] = [];

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `portal-test-${suffix}` }, fn);
const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalA, { requestId: `portal-test-${suffix}` }, fn);
const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalB, { requestId: `portal-test-${suffix}` }, fn);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A live pending survey on a ticket (replacing whatever the resolution hook issued), so "to rate" has something to count. */
async function pendingSurveyOn(tx: Tx, ticketId: string) {
  const [t] = await tx.select({ customerId: schema.tickets.customerId, type: schema.tickets.type }).from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  await tx.delete(schema.ticketSurveys).where(eq(schema.ticketSurveys.ticketId, ticketId));
  await tx.insert(schema.ticketSurveys).values({ ticketId, customerId: t!.customerId, ticketType: t!.type, trigger: 'resolved', question: 'How did we do?', tokenHash: `portal-${suffix}-${ticketId}`, tokenPrefix: 'portal', tokenEnc: 'x', status: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000) });
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.sourcePortal = await optionId(tx, 'ticket_source', 'portal');
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [workflow] = await tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.name, 'Customer approval')).limit(1);
    if (!workflow) throw new Error('"Customer approval" workflow missing (seed not applied?)');

    const [a] = await tx.insert(schema.customers).values({ code: `PA${suffix}`.toUpperCase(), name: `Portal Customer A ${suffix}`, accountManagerId: adminUser.id }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `PB${suffix}`.toUpperCase(), name: `Portal Customer B ${suffix}` }).returning();
    ids.customerA = a.id;
    ids.customerB = b.id;
    const [siteA] = await tx.insert(schema.sites).values({ customerId: a.id, code: 'HQ', name: 'A Head Office', isPrimary: true }).returning();
    const [siteB] = await tx.insert(schema.sites).values({ customerId: b.id, code: 'HQ', name: 'B Head Office', isPrimary: true }).returning();
    ids.siteA = siteA.id;
    ids.siteB = siteB.id;
    const [service] = await tx.insert(schema.services).values({ key: `portal_svc_${suffix}`, name: `Portal Service ${suffix}`, domain: 'noc' }).returning();
    ids.service = service.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: a.id, number: `PCT-${suffix}`, name: `Portal AMC ${suffix}`, status: 'active', startDate: day(-30), endDate: day(335), slaPolicyId: policy?.id ?? null, escalationMatrix: [{ level: 1, name: 'Service Desk', afterMinutes: 60 }] }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: a.id, serviceId: service.id });
    await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: a.id, name: 'Site visits', quantity: '4', unit: 'visits', period: 'quarterly' });
    await tx.insert(schema.scopeItems).values([
      { contractId: contract.id, customerId: a.id, serviceId: service.id, name: 'Core network', classification: 'in_scope' },
      { contractId: contract.id, customerId: a.id, name: 'End-user laptops', classification: 'out_of_scope' },
    ]);
    const [plain] = await tx.insert(schema.catalogItems).values({ key: `portal_item_${suffix}`, name: `Portal request ${suffix}`, formSchema: [{ key: 'who', label: 'Who', type: 'text', required: true }], portalVisible: true, serviceId: service.id }).returning();
    const [withApproval] = await tx.insert(schema.catalogItems).values({ key: `portal_appr_${suffix}`, name: `Approved request ${suffix}`, formSchema: [], portalVisible: true, approvalWorkflowId: workflow.id }).returning();
    ids.catalogPlain = plain.id;
    ids.catalogApproval = withApproval.id;

    // Portal users: customer_admin for A, customer_user for B (roles scoped to their customer).
    const [userA] = await tx.insert(schema.users).values({ email: `portal.a.${suffix}@example.test`, name: 'Alice Admin', userType: 'customer', customerId: a.id, status: 'active', passwordHash: await hashPassword('Demo@12345') }).returning();
    const [userB] = await tx.insert(schema.users).values({ email: `portal.b.${suffix}@example.test`, name: 'Bob User', userType: 'customer', customerId: b.id, status: 'active' }).returning();
    ids.userA = userA.id;
    ids.userB = userB.id;
    await tx.insert(schema.userRoles).values([
      { userId: userA.id, roleId: await roleId(tx, 'customer_admin'), customerId: a.id },
      { userId: userB.id, roleId: await roleId(tx, 'customer_user'), customerId: b.id },
    ]);

    // Maintenance rows for both customers.
    const [visitA] = await tx.insert(schema.fieldVisits).values({ number: `PFV-${suffix}-A`, customerId: a.id, siteId: siteA.id, title: 'A quarterly check', status: 'completed', engineerId: adminUser.id, scheduledStart: new Date(Date.now() - 2 * 86_400_000), actualEnd: new Date(Date.now() - 2 * 86_400_000), workSummary: 'All good' }).returning();
    const [visitB] = await tx.insert(schema.fieldVisits).values({ number: `PFV-${suffix}-B`, customerId: b.id, siteId: siteB.id, title: 'B visit', status: 'scheduled', scheduledStart: new Date(Date.now() + 3 * 86_400_000) }).returning();
    ids.visitA = visitA.id;
    ids.visitB = visitB.id;
    const [programA] = await tx.insert(schema.pmPrograms).values({ customerId: a.id, siteId: siteA.id, contractId: contract.id, name: 'A switch PM', frequency: 'quarterly', startDate: day(-30) }).returning();
    const [programB] = await tx.insert(schema.pmPrograms).values({ customerId: b.id, siteId: siteB.id, name: 'B switch PM', frequency: 'quarterly', startDate: day(-30) }).returning();
    await tx.insert(schema.pmOccurrences).values([
      { programId: programA.id, customerId: a.id, plannedDate: day(15), status: 'planned' },
      { programId: programB.id, customerId: b.id, plannedDate: day(15), status: 'planned' },
    ]);

    ids.adminUser = adminUser.id;
  });
  // Principals are resolved outside the seeding transaction (loadPrincipal reads through the shared pool).
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portalA = (await loadPrincipal(ids.userA))!;
  portalB = (await loadPrincipal(ids.userB))!;
  expect(portalA.userType).toBe('customer');
  expect(portalA.customerScope).toEqual([ids.customerA]);

  // Tickets for both customers raised by the MSP, plus a request awaiting customer approval.
  await asAdmin(async (ctx) => {
    const ta = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, siteId: ids.siteA, serviceId: ids.service, title: `A incident ${suffix}`, description: 'A only' });
    const tb = await createTicket(ctx, { type: 'incident', customerId: ids.customerB, siteId: ids.siteB, title: `B incident ${suffix}`, description: 'B only' });
    const appr = await createTicket(ctx, { type: 'request', customerId: ids.customerA, title: `A request needing approval ${suffix}`, catalogItemId: ids.catalogApproval, formData: {} });
    ids.ticketA = ta.id;
    ids.ticketB = tb.id;
    ids.approvalTicket = appr.id;
    createdTickets.push(ta.id, tb.id, appr.id);
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    const ticketIds = [...new Set(createdTickets)];
    if (ticketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, ticketIds));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.customerA, ids.customerB].filter(Boolean)));
    if (ids.catalogPlain || ids.catalogApproval) await tx.delete(schema.catalogItems).where(inArray(schema.catalogItems.id, [ids.catalogPlain, ids.catalogApproval].filter(Boolean)));
    if (ids.customerA || ids.customerB) await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.customerA, ids.customerB].filter(Boolean)));
    if (ids.service) await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

describe('customer portal', () => {
  it('describes the customer, service team and permissions for the portal user', async () => {
    const me = await asA((ctx) => portal.me(ctx));
    expect(me.customer.id).toBe(ids.customerA);
    expect(me.sites.map((s) => s.id)).toEqual([ids.siteA]);
    expect(me.serviceTeam.accountManager?.name).toBe(admin.name);
    expect(me.permissions).toContain('portal:manage_users');
    expect(me.counts.open).toBeGreaterThanOrEqual(2);
    expect(me.preview).toBe(false);
    const meB = await asB((ctx) => portal.me(ctx));
    expect(meB.customer.id).toBe(ids.customerB);
    // Customer users see their asset inventory too; only administration stays with customer_admin.
    expect(meB.permissions).toContain('portal:assets');
    expect(meB.permissions).not.toContain('portal:manage_users');
  });

  it('lists only the customer\'s own tickets and ignores a foreign customerId', async () => {
    const res = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'all', customerId: ids.customerB }));
    const numbersA = res.items.map((t) => t.id);
    expect(numbersA).toContain(ids.ticketA);
    expect(numbersA).not.toContain(ids.ticketB);
    expect(res.counts.all).toBe(res.total);
    // Customer-safe rows: no e-mails, no internal fields.
    const row = res.items.find((t) => t.id === ids.ticketA)!;
    expect(row.siteName).toBe('A Head Office');
    expect(Object.keys(row)).not.toContain('customFields');
    expect(Object.keys(row)).not.toContain('tags');
    const resB = await asB((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'all' }));
    expect(resB.items.map((t) => t.id)).toEqual([ids.ticketB]);
  });

  it('refuses access to another customer\'s ticket', async () => {
    await expect(asA((ctx) => portal.getPortalTicket(ctx, ids.ticketB))).rejects.toThrow(/not found|permission|access/i);
    await expect(asB((ctx) => portal.getPortalTicket(ctx, ids.ticketA))).rejects.toThrow(/not found|permission|access/i);
  });

  it('creates a ticket as the requester with the portal source and in-scope classification', async () => {
    const t = await asA((ctx) => portal.createPortalTicket(ctx, { type: 'incident', title: `Portal raised ${suffix}`, description: 'from the portal', siteId: ids.siteA, serviceId: ids.service }));
    createdTickets.push(t.id);
    expect(t.requester?.id).toBe(ids.userA);
    expect(t.isMine).toBe(true);
    expect(t.scope.status).toBe('in_scope');
    expect(t.scope.label).toMatch(/Covered by contract/);
    expect(t.actions.comment).toBe(true);
    const [row] = await withSystem((tx) => tx.select({ sourceId: schema.tickets.sourceId, requesterUserId: schema.tickets.requesterUserId, customerId: schema.tickets.customerId }).from(schema.tickets).where(eq(schema.tickets.id, t.id)));
    expect(row.sourceId).toBe(ids.sourcePortal);
    expect(row.requesterUserId).toBe(ids.userA);
    expect(row.customerId).toBe(ids.customerA);

    // Catalog request with its form.
    const r = await asA((ctx) => portal.createPortalTicket(ctx, { type: 'request', title: `Portal request ${suffix}`, catalogItemId: ids.catalogPlain, formData: { who: 'Alice' } }));
    createdTickets.push(r.id);
    expect(r.type).toBe('request');
    expect(r.form).toEqual([{ key: 'who', label: 'Who', type: 'text', value: 'Alice' }]);
    await expect(asA((ctx) => portal.createPortalTicket(ctx, { type: 'request', title: `Bad request ${suffix}`, catalogItemId: ids.catalogPlain, formData: {} }))).rejects.toThrow(/Required form fields/);
  });

  it('adds a public comment and never exposes internal notes', async () => {
    const c = await asA((ctx) => portal.commentOnTicket(ctx, ids.ticketA, 'Any update?'));
    const [row] = await withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.id, c.id)));
    expect(row.isInternal).toBe(false);
    expect(row.kind).toBe('comment');
    expect(row.authorId).toBe(ids.userA);
    await withSystem((tx) => tx.insert(schema.ticketComments).values({ ticketId: ids.ticketA, customerId: ids.customerA, authorName: 'Engineer', kind: 'work_note', isInternal: true, body: 'INTERNAL work note' }));
    const detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.timeline.some((i) => i.kind === 'comment' && i.body === 'Any update?')).toBe(true);
    expect(detail.timeline.some((i) => i.isInternal || /INTERNAL/.test(i.body ?? ''))).toBe(false);
    expect(detail.timeline.some((i) => i.kind === 'activity' && i.type === 'scope')).toBe(false);
    expect(detail.assignee === null || !('email' in detail.assignee)).toBe(true);
  });

  it('a customer reply on a ticket awaiting the customer sends it back to the service desk and resumes the SLA', async () => {
    const pendingId = await withSystem((tx) => optionId(tx, 'ticket_status', 'pending_customer'));
    // A wait needs a reason; for a customer wait it is posted as a reply the customer reads.
    await expect(asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: pendingId }))).rejects.toThrow(/reason is required/);
    await asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: pendingId, pendingReason: 'Please send the serial number of the switch.' }));
    const paused = await withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ids.ticketA)));
    expect(paused.length).toBeGreaterThan(0);
    // Only the resolution and restoration clocks stop; the first-answer clocks keep running.
    expect(paused.filter((r) => r.metric === 'resolution' || r.metric === 'restoration').every((r) => r.state === 'paused')).toBe(true);
    expect(paused.filter((r) => r.metric === 'response' || r.metric === 'acknowledgement').every((r) => r.state !== 'paused')).toBe(true);

    // The portal shows it as waiting on the customer.
    const waiting = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'awaiting' } as Parameters<typeof portal.listPortalTickets>[1]));
    expect(waiting.items.some((t) => t.id === ids.ticketA && t.awaitingCustomer)).toBe(true);
    expect(waiting.counts.awaiting).toBeGreaterThanOrEqual(1);

    // An engineer's own comment does not end the wait; the customer's reply does.
    await asAdmin((ctx) => addComment(ctx, ids.ticketA, { kind: 'comment', body: 'Still waiting for the serial number.' }));
    let detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('pending_customer');
    // The customer reads the wait in their own words, with the reason because it was shown to them, and nothing else.
    expect(detail.pending).toEqual({ waitingOn: 'customer', waitingOnLabel: 'We need something from you', reason: 'Please send the serial number of the switch.', expectedAt: null });

    await asA((ctx) => portal.commentOnTicket(ctx, ids.ticketA, 'The serial number is SN-12345.'));
    detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('in_progress');
    expect(detail.timeline.some((i) => i.kind === 'activity' && /Customer replied/.test(i.summary ?? ''))).toBe(true);
    const resumed = await withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ids.ticketA)));
    expect(resumed.every((r) => r.state !== 'paused' && r.pausedAt === null)).toBe(true);
    const after = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'awaiting' } as Parameters<typeof portal.listPortalTickets>[1]));
    expect(after.items.some((t) => t.id === ids.ticketA)).toBe(false);
    const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(and(eq(schema.auditLog.entityId, ids.ticketA), eq(schema.auditLog.action, 'ticket.customer_reply'))));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // A further customer comment on a ticket that is already in progress changes nothing.
    await asA((ctx) => portal.commentOnTicket(ctx, ids.ticketA, 'Thanks.'));
    detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('in_progress');
    expect(detail.pending).toBeNull();
  });

  it('a supplier wait whose reason stays with the desk reaches the customer without the reason; an internal hold shows the customer no wait', async () => {
    const vendorId = await withSystem((tx) => optionId(tx, 'ticket_status', 'pending_vendor'));
    const holdId = await withSystem((tx) => optionId(tx, 'ticket_status', 'on_hold'));
    const inProgressId = await withSystem((tx) => optionId(tx, 'ticket_status', 'in_progress'));
    const secret = `ISP case 4411, their engineer is late ${suffix}`;
    await asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: vendorId, pendingReason: secret, tellCustomer: false, pendingReference: 'ISP-4411', expectedAt: new Date('2030-01-15T00:00:00Z') }));
    let detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('pending_vendor');
    expect(detail.pending).toEqual({ waitingOn: 'vendor', waitingOnLabel: 'Waiting on a supplier or third party', reason: null, expectedAt: new Date('2030-01-15T00:00:00Z') });
    expect(Object.keys(detail.pending!).sort()).toEqual(['expectedAt', 'reason', 'waitingOn', 'waitingOnLabel']);
    // The conversation never carries the hidden reason or the reference; the customer row names the wait and the date.
    const text = JSON.stringify(detail.timeline);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('ISP-4411');
    expect(detail.timeline.some((i) => i.kind === 'activity' && i.type === 'pending' && /Waiting on a supplier or third party · expected 15 Jan 2030/.test(i.summary ?? ''))).toBe(true);
    // A customer comment does not end a supplier wait.
    await asA((ctx) => portal.commentOnTicket(ctx, ids.ticketA, 'Any news from the supplier?'));
    detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('pending_vendor');

    // An internal hold: the customer's pending block is null and nothing about the hold reaches the conversation; on the portal list row and the
    // detail the ticket reads as the type's working status (In Progress), while the staff record keeps On Hold.
    await asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: holdId, pendingReason: 'Waiting for the storage team', waitingOn: 'internal' }));
    detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.pending).toBeNull();
    expect(detail.status?.key).toBe('in_progress');
    expect(detail.status?.label).toBe('In Progress');
    const held = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50 } as Parameters<typeof portal.listPortalTickets>[1]));
    const heldRow = held.items.find((t) => t.id === ids.ticketA)!;
    expect(heldRow.status.key).toBe('in_progress');
    expect([heldRow.awaitingCustomer, heldRow.waitingOn]).toEqual([false, null]);
    // The Waiting on you number counts the rows flagged as waiting on the organisation (the request awaiting its approval), never the held ticket.
    expect(held.counts.awaiting).toBe(held.items.filter((t) => t.awaitingCustomer).length);
    expect(held.items.filter((t) => t.awaitingCustomer).map((t) => t.id)).not.toContain(ids.ticketA);
    // Nothing of the hold leaves: no "internal", no "On Hold" and no reason in the whole portal payload.
    expect(JSON.stringify(detail)).not.toMatch(/On Hold|internal|storage team/);
    const [staffRow] = await withSystem((tx) => tx.select({ statusId: schema.tickets.statusId, pendingWaitingOn: schema.tickets.pendingWaitingOn }).from(schema.tickets).where(eq(schema.tickets.id, ids.ticketA)));
    expect([staffRow.statusId, staffRow.pendingWaitingOn]).toEqual([holdId, 'internal']);
    expect(JSON.stringify(detail.timeline)).not.toContain('storage team');
    expect(detail.timeline.some((i) => i.kind === 'activity' && i.type === 'status' && /On Hold/.test(i.summary ?? ''))).toBe(false);
    await asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: inProgressId }));
    detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('in_progress');
  });

  it('lists the pending approval for the customer administrator and approves it', async () => {
    const list = await asA((ctx) => portal.listPortalApprovals(ctx));
    const pending = list.items.find((a) => a.ticket.id === ids.approvalTicket);
    expect(pending).toBeTruthy();
    expect(pending!.status).toBe('pending');
    // The inbox row and the ticket's approvals carry what needs approving, by when and who asked (the catalog item's approval, due by the default).
    expect(pending!.purpose).toBe(`Approval for Approved request ${suffix}`);
    expect(pending!.dueAt).toBeInstanceOf(Date);
    expect(pending!.requestedByName).toBe(admin.name);
    const before = await asA((ctx) => portal.getPortalTicket(ctx, ids.approvalTicket));
    expect(before.approvals.find((a) => a.id === pending!.id)).toMatchObject({ purpose: `Approval for Approved request ${suffix}`, requestedByName: admin.name });
    expect(before.approvals.find((a) => a.id === pending!.id)?.dueAt).toBeInstanceOf(Date);
    expect(before.pending).toMatchObject({ waitingOn: 'customer', waitingOnLabel: 'Your approval is needed', reason: `Approval for Approved request ${suffix}` });
    // The customer_user of B holds no portal:approve.
    await expect(asB((ctx) => portal.listPortalApprovals(ctx))).rejects.toThrow(/portal:approve/);
    const res = await asA((ctx) => portal.decidePortalApproval(ctx, ids.approvalTicket, pending!.id, 'approved', 'Looks fine'));
    expect(res.approvalStatus).toBe('approved');
    expect(res.items.find((a) => a.id === pending!.id)?.status).toBe('approved');
    const after = await asA((ctx) => portal.getPortalTicket(ctx, ids.approvalTicket));
    expect(after.approvalStatus).toBe('approved');
    expect(after.pendingForMe).toEqual([]);
    // The decision note is on the timeline and the ticket is back with the desk; the wait is over.
    expect(after.timeline.some((i) => i.kind === 'activity' && /approved by .*: Looks fine/.test(i.summary ?? ''))).toBe(true);
    expect(after.status?.key).toBe('in_fulfilment');
    expect(after.pending).toBeNull();
  });

  it('returns the services view with the customer\'s contract, scope, SLA targets and entitlements', async () => {
    const view = await asA((ctx) => portal.portalServices(ctx));
    const contract = view.contracts.find((c) => c.id === ids.contract)!;
    expect(contract).toBeTruthy();
    expect(contract.services.map((s) => s.id)).toEqual([ids.service]);
    expect(contract.scopeGroups.flatMap((g) => g.items.map((i) => i.classification)).sort()).toEqual(['in_scope', 'out_of_scope']);
    expect(contract.slaPolicy?.targets.length).toBeGreaterThan(0);
    expect(contract.escalationMatrix[0]).toMatchObject({ level: 1, name: 'Service Desk' });
    expect(Object.keys(contract)).not.toContain('value');
    expect(view.entitlements.map((e) => e.name)).toEqual(['Site visits']);
    expect(view.entitlements[0].utilization.quantity).toBe(4);
    const viewB = await asB((ctx) => portal.portalServices(ctx));
    expect(viewB.contracts).toEqual([]);
  });

  it('manages portal users within the customer only', async () => {
    const created = await asA((ctx) => portal.createPortalUser(ctx, { email: `invited.${suffix}@example.test`, name: 'Invited User', role: 'customer_user' }));
    expect(created.user.role).toBe('customer_user');
    expect(created.temporaryPassword).toBeTruthy();
    const [row] = await withSystem((tx) => tx.select({ customerId: schema.users.customerId, userType: schema.users.userType }).from(schema.users).where(eq(schema.users.id, created.user.id)));
    expect(row.customerId).toBe(ids.customerA);
    expect(row.userType).toBe('customer');
    const roles = await withSystem((tx) => tx.select({ customerId: schema.userRoles.customerId }).from(schema.userRoles).where(eq(schema.userRoles.userId, created.user.id)));
    expect(roles.map((r) => r.customerId)).toEqual([ids.customerA]);

    await expect(asA((ctx) => portal.createPortalUser(ctx, { email: `msp.${suffix}@example.test`, name: 'Sneaky', role: 'admin' as never }))).rejects.toThrow(/customer_user or customer_admin/);

    const list = await asA((ctx) => portal.listPortalUsers(ctx, { page: 1, pageSize: 50 }));
    const listed = list.items.map((u) => u.id);
    expect(listed).toContain(ids.userA);
    // the WhatsApp state travels with every row (verified number and the chat flag), never the preferences themselves
    for (const u of list.items) {
      expect(typeof u.assistantOn).toBe('boolean');
      expect(u).toHaveProperty('whatsappVerifiedAt');
      expect(u).not.toHaveProperty('preferences');
    }
    expect(listed).toContain(created.user.id);
    expect(listed).not.toContain(ids.userB);
    expect(listed).not.toContain(admin.id);

    const updated = await asA((ctx) => portal.updatePortalUser(ctx, created.user.id, { role: 'customer_admin', title: 'Lead' }));
    expect(updated.role).toBe('customer_admin');
    expect(updated.title).toBe('Lead');
    await expect(asA((ctx) => portal.updatePortalUser(ctx, ids.userB, { name: 'Hacked' }))).rejects.toThrow(/not found/i);
    await expect(asA((ctx) => portal.updatePortalUser(ctx, ids.userA, { role: 'customer_user' }))).rejects.toThrow(/own role/);
    const reset = await asA((ctx) => portal.resetPortalUserPassword(ctx, created.user.id));
    expect(reset.temporaryPassword).toBeTruthy();
    await expect(asB((ctx) => portal.listPortalUsers(ctx, { page: 1, pageSize: 50 }))).rejects.toThrow(/portal:manage_users/);
  });

  it('shows maintenance rows of the own customer only and lets the customer acknowledge a completed visit', async () => {
    const view = await asA((ctx) => portal.portalMaintenance(ctx, { pastDays: 90, futureDays: 90 }));
    const allVisits = [...view.upcoming.visits, ...view.past.visits];
    expect(allVisits.map((v) => v.id)).toEqual([ids.visitA]);
    expect([...view.upcoming.occurrences, ...view.past.occurrences].map((o) => o.programName)).toEqual(['A switch PM']);
    const done = view.past.visits.find((v) => v.id === ids.visitA)!;
    expect(done.canAcknowledge).toBe(true);
    expect(done.workSummary).toBe('All good');
    const viewB = await asB((ctx) => portal.portalMaintenance(ctx, { pastDays: 90, futureDays: 90 }));
    expect([...viewB.upcoming.visits, ...viewB.past.visits].map((v) => v.id)).toEqual([ids.visitB]);
    // The navigator's visits badge is the length of the upcoming-visits list it opens (one predicate): A's visit is completed, B's is scheduled ahead.
    expect(view.upcoming.visits).toEqual([]);
    expect(viewB.upcoming.visits.map((v) => v.id)).toEqual([ids.visitB]);
    expect((await asA((ctx) => portal.me(ctx))).counts.upcomingVisits).toBe(view.upcoming.visits.length);
    expect((await asB((ctx) => portal.me(ctx))).counts.upcomingVisits).toBe(viewB.upcoming.visits.length);
    expect((await asB((ctx) => portal.me(ctx))).counts.upcomingVisits).toBe(1);
    await expect(asB((ctx) => portal.acknowledgePortalVisit(ctx, ids.visitA, { name: 'Bob' }))).rejects.toThrow(/not found/i);
    const ack = await asA((ctx) => portal.acknowledgePortalVisit(ctx, ids.visitA, { name: 'Alice Admin', title: 'IT Manager', rating: 5 }));
    expect(ack.acknowledged).toBe(true);
    const [row] = await withSystem((tx) => tx.select({ ackName: schema.fieldVisits.customerAckName, rating: schema.fieldVisits.customerRating }).from(schema.fieldVisits).where(eq(schema.fieldVisits.id, ids.visitA)));
    expect(row.ackName).toBe('Alice Admin');
    expect(row.rating).toBe(5);
  });

  it('lets an MSP administrator preview a customer portal read-only but never act in it', async () => {
    const me = await asAdmin((ctx) => portal.me(ctx, ids.customerA));
    expect(me.preview).toBe(true);
    expect(me.customer.id).toBe(ids.customerA);
    await expect(asAdmin((ctx) => portal.me(ctx))).rejects.toThrow(/customerId is required/);
    await expect(asAdmin((ctx) => portal.commentOnTicket(ctx, ids.ticketA, 'nope'))).rejects.toThrow(/only available to customer users/);
  });
});

/**
 * The portal list on the staff vocabulary: the explicit keys and the chip
 * aliases resolve to the same predicates, the stats endpoint's tiles and chips
 * never move each other, scope keys move them, staff-only keys are stripped,
 * and the organisation's "open" and "to rate" numbers are the same in the
 * navigator, on the list and on GET /portal/surveys.
 */
describe('portal ticket list vocabulary', () => {
  let pendingCustomerId = '';
  let resolved = '';
  let reopened = '';
  const stats = (q: Parameters<typeof portal.portalTicketStats>[1]) => asA((ctx) => portal.portalTicketStats(ctx, q));
  const count = (q: Parameters<typeof portal.countPortalTickets>[1]) => asA((ctx) => portal.countPortalTickets(ctx, q));
  const tiles = (x: Awaited<ReturnType<typeof portal.portalTicketStats>>) => ({ open: x.open, awaiting: x.awaiting, breached: x.breached, atRisk: x.atRisk, toRate: x.toRate, resolved: x.resolved, closed: x.closed, all: x.all, byStatusCategory: x.byStatusCategory, byType: x.byType, allTypes: x.allTypes });

  beforeAll(async () => {
    // Customer A so far: the incident (in progress), the approved request, "Portal raised" and "Portal request" (both raised by Alice). Add a resolved
    // ticket with a live survey, a ticket reopened behind the hook with its survey still live, a breached clock and a ticket waiting on the customer.
    await asAdmin(async (ctx) => {
      const r = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, title: `A resolved to rate ${suffix}`, description: 'done' });
      const x = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, title: `A reopened with a live survey ${suffix}`, description: 'not done' });
      createdTickets.push(r.id, x.id);
      resolved = r.id;
      reopened = x.id;
      await resolveTicket(ctx, r.id, { resolutionNotes: 'Fixed' });
      await resolveTicket(ctx, x.id, { resolutionNotes: 'Fixed, or so we thought' });
    });
    await withSystem(async (tx) => {
      pendingCustomerId = await optionId(tx, 'ticket_status', 'pending_customer');
      await pendingSurveyOn(tx, resolved);
      await pendingSurveyOn(tx, reopened);
      await tx.update(schema.tickets).set({ statusId: await optionId(tx, 'ticket_status', 'in_progress') }).where(eq(schema.tickets.id, reopened));
      await tx.execute(sql`UPDATE ticket_slas SET state = 'breached', breached_at = now() WHERE ticket_id = ${ids.ticketA}::uuid AND metric = 'resolution'`);
      const [req] = await tx.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.customerId, ids.customerA), eq(schema.tickets.title, `Portal request ${suffix}`)));
      // The wait is the column (what `changeStatus` writes with the status); the status key alone counts nowhere.
      await tx.update(schema.tickets).set({ statusId: pendingCustomerId, pendingWaitingOn: 'customer', pendingReason: 'Please confirm the delivery address', pendingSetAt: new Date() }).where(eq(schema.tickets.id, req!.id));
    });
  });

  it('accepts the staff keys and the chip aliases, and both resolve to the same list', async () => {
    // Six tickets: five open (one of them waiting on the customer, one breached, one reopened), one resolved with a live survey.
    expect(await count({})).toBe(5);
    expect(await count({ statusCategory: 'any' })).toBe(6);
    expect(await count({ status: 'all' })).toBe(6);
    expect(await count({ status: 'open', statusCategory: 'any' })).toBe(6);
    expect(await count({ statusCategory: 'resolved' })).toBe(1);
    expect(await count({ status: 'resolved' })).toBe(1);
    expect(await count({ statusCategory: 'resolved,closed', csat: 'pending' })).toBe(1);
    expect(await count({ status: 'rate' })).toBe(1);
    expect(await count({ statusId: pendingCustomerId })).toBe(1);
    expect(await count({ status: 'awaiting' })).toBe(1);
    // One word for what waits on the organisation: the chip alias and the key are the same list.
    expect(await count({ waitingOn: 'customer' })).toBe(1);
    expect(await count({ waitingOn: 'customer', statusCategory: 'any' })).toBe(1);
    expect(await count({ slaState: 'breached' })).toBe(1);
    expect(await count({ slaState: 'at_risk,ok' })).toBe(4);
    // A resolved range counts by resolution day whatever the current status (the reopened ticket keeps its resolution time).
    expect(await count({ statusCategory: 'any', resolvedFrom: day(0), resolvedTo: day(0) })).toBe(2);
    expect(await count({ statusCategory: 'any', resolvedFrom: day(-3), resolvedTo: day(-1) })).toBe(0);
    expect(await count({ statusCategory: 'any', createdFrom: day(1) })).toBe(0);
    expect(await count({ siteId: ids.siteA })).toBe(2);
    expect(await count({ serviceId: ids.service })).toBe(3);
    expect(await count({ mine: true })).toBe(2);
    expect(await count({ type: 'request' })).toBe(2);
    expect(await count({ priority: 'p9' })).toBe(0);
    const list = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, statusCategory: 'any' }));
    expect(list.total).toBe(6);
    expect(list.counts.all).toBe(6);
    expect(Object.keys(list.items[0]!)).not.toContain('customerName');
    const toRate = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'rate' }));
    expect(toRate.items.map((t) => t.id)).toEqual([resolved]);
  });

  it('accepts waitingOn=customer alone: any other party is the desk\'s business and the route refuses it', async () => {
    expect(portalTicketStatsQuery.safeParse({ waitingOn: 'customer' }).success).toBe(true);
    for (const party of ['vendor', 'change', 'agreement', 'internal', 'customer,vendor']) expect(portalTicketStatsQuery.safeParse({ waitingOn: party }).success, party).toBe(false);
    const app = await buildApp();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `portal.a.${suffix}@example.test`, password: 'Demo@12345' } });
      expect(login.statusCode).toBe(200);
      const headers = { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` };
      const ok = await app.inject({ method: 'GET', url: '/api/portal/tickets?waitingOn=customer', headers });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { total: number; items: { awaitingCustomer: boolean }[] }).total).toBe(1);
      expect((ok.json() as { items: { awaitingCustomer: boolean }[] }).items.every((t) => t.awaitingCustomer)).toBe(true);
      // The route's own schema refuses every other party (the app answers a schema refusal with 400 `validation_error`, as every route does).
      for (const url of ['/api/portal/tickets?waitingOn=vendor', '/api/portal/tickets/stats?waitingOn=vendor', '/api/portal/tickets?waitingOn=internal', '/api/portal/tickets?waitingOn=customer,vendor']) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(400);
        expect((res.json() as { error: string }).error, url).toBe('validation_error');
      }
      // The legacy chip alias still answers through the one key.
      const alias = await app.inject({ method: 'GET', url: '/api/portal/tickets?status=awaiting', headers });
      expect((alias.json() as { total: number }).total).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('accepts the SLA outcome keys (the home\'s compliance doors), refuses the window alone, and the rows stay the portal\'s own', async () => {
    // The resolved ticket and the reopened one (reopened behind the engine, its clock still reads met) ended their resolution clocks today; ticket A carries the breached flag.
    expect(await count({ statusCategory: 'any', slaOutcome: 'met', slaEndedFrom: day(0), slaEndedTo: day(0) })).toBe(2);
    expect(await count({ statusCategory: 'any', slaOutcome: 'breached', slaEndedFrom: day(0), slaEndedTo: day(0) })).toBe(1);
    expect(await count({ statusCategory: 'any', slaOutcome: 'met', slaEndedFrom: day(-3), slaEndedTo: day(-1) })).toBe(0);
    // Without `statusCategory=any` the open categories apply: a met clock on a resolved ticket is hidden, the reopened one shows.
    expect(await count({ slaOutcome: 'met', slaEndedFrom: day(0), slaEndedTo: day(0) })).toBe(1);
    await expect(count({ statusCategory: 'any', slaEndedFrom: day(0) })).rejects.toBeInstanceOf(ValidationError);
    await expect(stats({ slaEndedTo: day(0) })).rejects.toBeInstanceOf(ValidationError);
    const s = await stats({ statusCategory: 'any', slaOutcome: 'breached', slaEndedFrom: day(0), slaEndedTo: day(0) });
    expect(s.total).toBe(1);
    expect(s.breached).toBe(1);
    const list = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, statusCategory: 'any', slaOutcome: 'breached', slaEndedFrom: day(0), slaEndedTo: day(0) }));
    expect(list.items.map((t) => t.id)).toEqual([ids.ticketA]);
    expect(Object.keys(list.items[0]!)).not.toContain('customerName');
    expect(portalTicketStatsQuery.parse({ slaOutcome: 'met', slaEndedFrom: day(0), slaEndedTo: day(0) })).toMatchObject({ slaOutcome: 'met' });
    expect(portalTicketStatsQuery.safeParse({ slaOutcome: 'late' }).success).toBe(false);
    // Another organisation reads nothing through the same door.
    expect(await asB((ctx) => portal.countPortalTickets(ctx, { statusCategory: 'any', slaOutcome: 'breached', slaEndedFrom: day(0), slaEndedTo: day(0) }))).toBe(0);
  });

  it('the stats tiles and chips never move each other; the list total follows the condition', async () => {
    const base = await stats({});
    expect(tiles(base)).toEqual({ open: 5, awaiting: 1, breached: 1, atRisk: 0, toRate: 1, resolved: 1, closed: 0, all: 6, byStatusCategory: { open: 3, new: 1, pending: 1, resolved: 1 }, byType: { incident: 3, request: 2 }, allTypes: 5 });
    expect(base.total).toBe(5);
    expect(base.series).toHaveLength(14);
    const cases: [Parameters<typeof portal.portalTicketStats>[1], number][] = [
      [{ statusCategory: 'resolved' }, 1],
      [{ status: 'resolved' }, 1],
      [{ statusId: pendingCustomerId }, 1],
      [{ status: 'awaiting' }, 1],
      [{ waitingOn: 'customer' }, 1],
      [{ statusCategory: 'resolved,closed', csat: 'pending' }, 1],
      [{ status: 'rate' }, 1],
      [{ slaState: 'breached' }, 1],
      [{ statusCategory: 'any' }, 6],
      [{ status: 'all' }, 6],
    ];
    for (const [q, total] of cases) {
      const s = await stats(q);
      expect(tiles(s), JSON.stringify(q)).toEqual(tiles(base));
      expect(s.total, JSON.stringify(q)).toBe(total);
    }
    // The tiles reproduce on the list they open.
    expect(await count({ slaState: 'breached' })).toBe(base.breached);
    expect(await count({ statusId: pendingCustomerId })).toBe(base.awaiting);
    expect(await count({ statusCategory: 'resolved,closed', csat: 'pending' })).toBe(base.toRate);
    expect(await count({ statusCategory: 'resolved' })).toBe(base.resolved);
    expect(await count({ statusCategory: 'closed,cancelled' })).toBe(base.closed);
  });

  it('scope keys (search, site, service, priority, created range, type, raised by me) move the tiles and chips with the list', async () => {
    const mine = await stats({ mine: true });
    expect([mine.open, mine.awaiting, mine.toRate, mine.all, mine.allTypes]).toEqual([2, 1, 0, 2, 2]);
    expect(mine.byType).toEqual({ incident: 1, request: 1 });
    const site = await stats({ siteId: ids.siteA });
    expect([site.open, site.breached, site.total]).toEqual([2, 1, 2]);
    const service = await stats({ serviceId: ids.service });
    expect([service.open, service.total]).toEqual([3, 3]);
    const nobody = await stats({ priorityId: '00000000-0000-0000-0000-000000000000' });
    expect([nobody.open, nobody.all, nobody.allTypes, nobody.total]).toEqual([0, 0, 0, 0]);
    const future = await stats({ createdFrom: day(1) });
    expect([future.open, future.toRate, future.total]).toEqual([0, 0, 0]);
    // The type pill keeps the tiles on its own scope while All and the per-type counts ignore it.
    const requests = await stats({ type: 'request' });
    expect([requests.open, requests.awaiting, requests.total, requests.allTypes]).toEqual([2, 1, 2, 5]);
    expect(requests.byType).toEqual({ incident: 3, request: 2 });
    expect(requests.byStatusCategory).toEqual({ open: 1, pending: 1 });
    const found = await stats({ q: `reopened with a live survey ${suffix}` });
    expect(found.open).toBe(await count({ q: `reopened with a live survey ${suffix}` }));
    expect(found.open).toBeGreaterThanOrEqual(1);
    expect(found.open).toBeLessThan(5);
  });

  it('staff-only keys from a customer user are stripped and never widen the scope; another organisation sees only its own', async () => {
    const base = await stats({});
    const smuggled = portalTicketStatsQuery.parse({ customerId: ids.customerB, assignee: 'me', assigneeId: ids.adminUser, teamId: ids.service, domain: 'soc', unassigned: 'true', isMajor: 'true', knownError: 'true', csat: 'pending' });
    expect(Object.keys(smuggled).sort()).toEqual(['csat', 'customerId']);
    const s = await stats(smuggled);
    expect(tiles(s)).toEqual(tiles(base));
    // `csat=pending` without a status key is the To rate door (the rateable categories stand in for the open default), so its list is the To rate number.
    expect(s.total).toBe(base.toRate);
    expect(await count({ csat: 'pending' })).toBe(base.toRate);
    expect(await count({ csat: 'pending' })).toBe(await count({ statusCategory: 'resolved,closed', csat: 'pending' }));
    expect(await count({ csat: 'pending' })).toBe(await count({ status: 'rate' }));
    // An unknown category, or `any` combined with one, is refused rather than served as an empty or narrowed list.
    expect(portalTicketStatsQuery.safeParse({ statusCategory: 'bogus' }).success).toBe(false);
    expect(portalTicketStatsQuery.safeParse({ statusCategory: 'any,resolved' }).success).toBe(false);
    expect(portalTicketStatsQuery.safeParse({ statusCategory: 'resolved,closed' }).success).toBe(true);
    expect(portalTicketStatsQuery.safeParse({ statusCategory: 'any' }).success).toBe(true);
    expect(await count(portalTicketStatsQuery.parse({ customerId: ids.customerB }))).toBe(5);
    await expect(Promise.resolve().then(() => portalTicketStatsQuery.parse({ csat: 'rated' }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => portalTicketStatsQuery.parse({ createdFrom: 'yesterday' }))).rejects.toThrow();
    const b = await asB((ctx) => portal.portalTicketStats(ctx, { statusCategory: 'any' }));
    expect([b.open, b.all, b.toRate, b.total]).toEqual([1, 1, 0, 1]);
    expect(await asB((ctx) => portal.countPortalTickets(ctx, { statusCategory: 'any', siteId: ids.siteA }))).toBe(0);
    // An MSP administrator previewing the portal reads the same numbers for the organisation.
    const preview = await asAdmin((ctx) => portal.portalTicketStats(ctx, { customerId: ids.customerA }));
    expect(tiles(preview)).toEqual(tiles(base));
  });

  it('one "open" and one "to rate" number: the navigator, the list tiles and GET /portal/surveys agree, and a reopened ticket with a live survey counts nowhere', async () => {
    const me = await asA((ctx) => portal.me(ctx));
    const base = await stats({});
    const surveys = await asA((ctx) => pendingForPortal(ctx));
    expect(me.counts.open).toBe(base.open);
    expect(me.counts.toRate).toBe(base.toRate);
    expect(surveys.count).toBe(base.toRate);
    expect(me.counts).toMatchObject({ open: 5, awaiting: 1, resolved: 1, closed: 0, toRate: 1, all: 6 });
    expect(Object.keys(me.counts).sort()).toEqual(['all', 'awaiting', 'closed', 'open', 'pendingApprovals', 'resolved', 'toRate', 'upcomingVisits']);
    expect(surveys.items.map((i) => i.ticketId)).toEqual([resolved]);
    expect(await count({ status: 'rate' })).toBe(1);
    const toRateRows = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, statusCategory: 'resolved,closed', csat: 'pending' }));
    expect(toRateRows.items.map((t) => t.id)).not.toContain(reopened);
    // Once the reopened ticket ends again its live survey is "to rate" everywhere at once.
    await withSystem(async (tx) => {
      await tx.update(schema.tickets).set({ statusId: await optionId(tx, 'ticket_status', 'resolved') }).where(eq(schema.tickets.id, reopened));
    });
    const after = await stats({});
    expect(after.toRate).toBe(2);
    expect((await asA((ctx) => portal.me(ctx))).counts.toRate).toBe(2);
    expect((await asA((ctx) => pendingForPortal(ctx))).count).toBe(2);
    expect(await count({ statusCategory: 'resolved,closed', csat: 'pending' })).toBe(2);
  });
});
