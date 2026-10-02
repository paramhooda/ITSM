/**
 * Customer portal integration tests (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/portal.test.ts
 *
 * Two customers (A, B) with their own portal users; everything is exercised
 * through the portal service layer under the customer principals so tenant
 * isolation, permission limits and data shaping are verified end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import { createTicket, changeStatus } from '@/modules/tickets/service';
import { addComment } from '@/modules/tickets/activity';
import * as portal from '@/modules/portal/service';

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
    const [userA] = await tx.insert(schema.users).values({ email: `portal.a.${suffix}@example.test`, name: 'Alice Admin', userType: 'customer', customerId: a.id, status: 'active' }).returning();
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
    await asAdmin((ctx) => changeStatus(ctx, ids.ticketA, { statusId: pendingId }));
    const paused = await withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ids.ticketA)));
    expect(paused.length).toBeGreaterThan(0);
    expect(paused.every((r) => r.state === 'paused')).toBe(true);

    // The portal shows it as waiting on the customer.
    const waiting = await asA((ctx) => portal.listPortalTickets(ctx, { page: 1, pageSize: 50, status: 'awaiting' } as Parameters<typeof portal.listPortalTickets>[1]));
    expect(waiting.items.some((t) => t.id === ids.ticketA && t.awaitingCustomer)).toBe(true);
    expect(waiting.counts.awaiting).toBeGreaterThanOrEqual(1);

    // An engineer's own comment does not end the wait; the customer's reply does.
    await asAdmin((ctx) => addComment(ctx, ids.ticketA, { kind: 'comment', body: 'Still waiting for the serial number.' }));
    let detail = await asA((ctx) => portal.getPortalTicket(ctx, ids.ticketA));
    expect(detail.status?.key).toBe('pending_customer');

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
  });

  it('lists the pending approval for the customer administrator and approves it', async () => {
    const list = await asA((ctx) => portal.listPortalApprovals(ctx));
    const pending = list.items.find((a) => a.ticket.id === ids.approvalTicket);
    expect(pending).toBeTruthy();
    expect(pending!.status).toBe('pending');
    // The customer_user of B holds no portal:approve.
    await expect(asB((ctx) => portal.listPortalApprovals(ctx))).rejects.toThrow(/portal:approve/);
    const res = await asA((ctx) => portal.decidePortalApproval(ctx, ids.approvalTicket, pending!.id, 'approved', 'Looks fine'));
    expect(res.approvalStatus).toBe('approved');
    expect(res.items.find((a) => a.id === pending!.id)?.status).toBe('approved');
    const after = await asA((ctx) => portal.getPortalTicket(ctx, ids.approvalTicket));
    expect(after.approvalStatus).toBe('approved');
    expect(after.pendingForMe).toEqual([]);
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
