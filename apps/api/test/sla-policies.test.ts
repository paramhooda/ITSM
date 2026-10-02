import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { runAs } from '../src/core/context';
import { ValidationError, ConflictError, NotFoundError } from '../src/core/errors';
import * as policies from '../src/modules/sla/policies';
import * as catalog from '../src/modules/catalog/service';
import * as contracts from '../src/modules/contracts/service';
import * as services from '../src/modules/services/service';
import { addDays, todayStr } from '../src/modules/contracts/common';

/**
 * DB-backed tests for SLA policy administration and the service request catalog.
 * Requires DATABASE_URL etc. (same environment as the API) with the default seed applied.
 */

const suffix = Math.random().toString(36).slice(2, 8);
let admin: Principal;
let customerUser: Principal;
let customerId: string;
let otherCustomerId: string;
let bizCalendarId: string;
let c247CalendarId: string;
let p1: string;
let p3: string;
let onHoldStatusId: string;
let originalDefaultId: string | null = null;
let adminUserId: string;
let customerUserId: string;
const createdPolicyIds: string[] = [];
const createdItemIds: string[] = [];
const createdServiceIds: string[] = [];

async function asAdmin<T>(fn: Parameters<typeof runAs<T>>[2]) {
  return runAs(admin, { requestId: 'test' }, fn);
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select().from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('Seed admin user missing; run the seed first');
    const cals = await tx.select().from(schema.businessCalendars);
    bizCalendarId = cals.find((c) => !c.is24x7)!.id;
    c247CalendarId = cals.find((c) => c.is24x7)!.id;
    const prios = await tx.select().from(schema.configOptions).where(eq(schema.configOptions.type, 'ticket_priority'));
    p1 = prios.find((p) => p.key === 'p1')!.id;
    p3 = prios.find((p) => p.key === 'p3')!.id;
    const [onHold] = await tx.select().from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'on_hold')));
    onHoldStatusId = onHold.id;
    const [def] = await tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    originalDefaultId = def?.id ?? null;

    const [cust] = await tx.insert(schema.customers).values({ code: `TST${suffix}`.toUpperCase(), name: `Test Customer ${suffix}` }).returning();
    const [other] = await tx.insert(schema.customers).values({ code: `OTH${suffix}`.toUpperCase(), name: `Other Customer ${suffix}` }).returning();
    customerId = cust.id;
    otherCustomerId = other.id;
    const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const [user] = await tx.insert(schema.users).values({ email: `portal-${suffix}@example.test`, name: 'Portal User', userType: 'customer', customerId: cust.id, status: 'active' }).returning();
    await tx.insert(schema.userRoles).values({ userId: user.id, roleId: role.id, customerId: cust.id });
    invalidatePrincipal(user.id);
    adminUserId = adminUser.id;
    customerUserId = user.id;
  });
  // Principals are resolved through the shared pool, so load them once the setup transaction has committed.
  admin = (await loadPrincipal(adminUserId))!;
  customerUser = (await loadPrincipal(customerUserId))!;
  expect(customerUser?.userType).toBe('customer');
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (originalDefaultId) {
      await tx.update(schema.slaPolicies).set({ isDefault: false });
      await tx.update(schema.slaPolicies).set({ isDefault: true }).where(eq(schema.slaPolicies.id, originalDefaultId));
    }
    if (createdItemIds.length) await tx.delete(schema.catalogItems).where(inArray(schema.catalogItems.id, createdItemIds));
    if (createdPolicyIds.length) await tx.delete(schema.slaPolicies).where(inArray(schema.slaPolicies.id, createdPolicyIds));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [customerId, otherCustomerId]));
    if (createdServiceIds.length) await tx.delete(schema.services).where(inArray(schema.services.id, createdServiceIds));
  });
  await closeDb();
});

describe('SLA policies', () => {
  it('creates a policy with targets and reads it back with labels and usage', async () => {
    const created = await asAdmin((ctx) =>
      policies.createPolicy(ctx, {
        name: `Test policy ${suffix}`,
        description: 'created by test',
        calendarId: bizCalendarId,
        targets: [
          { ticketType: 'incident', priorityId: p1, metric: 'response', minutes: 30, warnPct: 80, calendarTime: true },
          { ticketType: 'incident', priorityId: p1, metric: 'resolution', minutes: 240, calendarTime: true },
          { ticketType: 'incident', priorityId: null, metric: 'resolution', minutes: 480 },
        ],
      }),
    );
    createdPolicyIds.push(created.id);
    expect(created.isDefault).toBe(false);
    expect(created.targets).toHaveLength(3);
    expect(created.targets.find((t) => t.priorityId === p1 && t.metric === 'response')?.priorityLabel).toContain('P1');
    expect(created.usage).toEqual({ contracts: 0, contractServices: 0, catalogItems: 0, services: 0, tickets: 0 });
    expect(created.calendarName).toBeTruthy();
    // incident response/resolution per priority, "any priority" last
    expect(created.targetSummary).toEqual([
      { priorityId: p1, priorityLabel: expect.stringContaining('P1'), priorityLevel: 1, response: 30, resolution: 240 },
      { priorityId: null, priorityLabel: 'Any priority', priorityLevel: null, response: null, resolution: 480 },
    ]);

    const listed = await asAdmin((ctx) => policies.listPolicies(ctx));
    expect(listed.items.some((p) => p.id === created.id)).toBe(true);
  });

  it('rejects duplicate targets when replacing', async () => {
    const id = createdPolicyIds[0];
    await expect(
      asAdmin((ctx) =>
        policies.replaceTargets(ctx, id, [
          { ticketType: 'request', priorityId: p3, metric: 'response', minutes: 60 },
          { ticketType: 'request', priorityId: p3, metric: 'response', minutes: 120 },
        ]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // original targets untouched after the failed (rolled back) replace
    const after = await asAdmin((ctx) => policies.getPolicy(ctx, id));
    expect(after.targets).toHaveLength(3);

    const replaced = await asAdmin((ctx) =>
      policies.replaceTargets(ctx, id, [
        { ticketType: 'request', priorityId: p3, metric: 'response', minutes: 60 },
        { ticketType: 'request', priorityId: null, metric: 'resolution', minutes: 1440 },
      ]),
    );
    expect(replaced.targets).toHaveLength(2);
  });

  it('validates pause statuses and stores them', async () => {
    const id = createdPolicyIds[0];
    await expect(asAdmin((ctx) => policies.setPauseStatuses(ctx, id, [p1]))).rejects.toBeInstanceOf(ValidationError);
    const updated = await asAdmin((ctx) => policies.setPauseStatuses(ctx, id, [onHoldStatusId]));
    expect(updated.pauseStatusIds).toEqual([onHoldStatusId]);
    expect(updated.pauseStatuses[0].label).toBe('On Hold');
  });

  it('setting a policy as default clears the previous default', async () => {
    const before = await asAdmin((ctx) => policies.listPolicies(ctx));
    const previousDefault = before.items.find((p) => p.isDefault);
    expect(previousDefault).toBeTruthy();

    const id = createdPolicyIds[0];
    const updated = await asAdmin((ctx) => policies.updatePolicy(ctx, id, { isDefault: true }));
    expect(updated.isDefault).toBe(true);
    const after = await asAdmin((ctx) => policies.listPolicies(ctx));
    expect(after.items.filter((p) => p.isDefault)).toHaveLength(1);
    expect(after.items.find((p) => p.id === previousDefault!.id)?.isDefault).toBe(false);

    // cannot simply unset the default; another policy has to take over
    await expect(asAdmin((ctx) => policies.updatePolicy(ctx, id, { isDefault: false }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to delete the default policy', async () => {
    const id = createdPolicyIds[0];
    await expect(asAdmin((ctx) => policies.deletePolicy(ctx, id))).rejects.toBeInstanceOf(ValidationError);
    // hand the default back to the original policy so the rest of the suite is unaffected
    if (originalDefaultId) await asAdmin((ctx) => policies.updatePolicy(ctx, originalDefaultId!, { isDefault: true }));
    const now = await asAdmin((ctx) => policies.getPolicy(ctx, id));
    expect(now.isDefault).toBe(false);
  });

  it('preview: business-hours targets are due later than 24x7 targets', async () => {
    const biz = await asAdmin((ctx) => policies.createPolicy(ctx, { name: `Biz ${suffix}`, calendarId: bizCalendarId, targets: [{ ticketType: 'incident', priorityId: null, metric: 'resolution', minutes: 480, calendarTime: false }] }));
    const round = await asAdmin((ctx) => policies.createPolicy(ctx, { name: `24x7 ${suffix}`, calendarId: c247CalendarId, targets: [{ ticketType: 'incident', priorityId: null, metric: 'resolution', minutes: 480, calendarTime: false }] }));
    createdPolicyIds.push(biz.id, round.id);
    // Thursday 2026-10-01 20:00 IST is outside business hours; Friday 2026-10-02 is a seeded holiday.
    const start = '2026-10-01T14:30:00.000Z';
    const bizPreview = await asAdmin((ctx) => policies.preview(ctx, { policyId: biz.id, ticketType: 'incident', priorityId: p3, start }));
    const roundPreview = await asAdmin((ctx) => policies.preview(ctx, { policyId: round.id, ticketType: 'incident', priorityId: p3, start }));
    expect(bizPreview.metrics).toHaveLength(1);
    expect(roundPreview.metrics).toHaveLength(1);
    expect(roundPreview.metrics[0].calendar).toBe('24x7');
    expect(new Date(roundPreview.metrics[0].dueAt).getTime()).toBe(new Date(start).getTime() + 480 * 60_000);
    expect(bizPreview.metrics[0].calendar).not.toBe('24x7');
    expect(new Date(bizPreview.metrics[0].dueAt).getTime()).toBeGreaterThan(new Date(roundPreview.metrics[0].dueAt).getTime());
    // calendarTime targets ignore the business calendar even on a business-hours policy
    await asAdmin((ctx) => policies.replaceTargets(ctx, biz.id, [{ ticketType: 'incident', priorityId: null, metric: 'resolution', minutes: 480, calendarTime: true }]));
    const forced = await asAdmin((ctx) => policies.preview(ctx, { policyId: biz.id, ticketType: 'incident', priorityId: p3, start }));
    expect(forced.metrics[0].calendar).toBe('24x7');
    expect(forced.metrics[0].dueAt).toBe(roundPreview.metrics[0].dueAt);
  });

  it('clones a policy with targets and pause statuses, then deletes the clone', async () => {
    const source = createdPolicyIds[0];
    const clone = await asAdmin((ctx) => policies.clonePolicy(ctx, source));
    expect(clone.name).toMatch(/^Copy of /);
    expect(clone.isDefault).toBe(false);
    expect(clone.targets).toHaveLength(2);
    expect(clone.pauseStatusIds).toEqual([onHoldStatusId]);
    const res = await asAdmin((ctx) => policies.deletePolicy(ctx, clone.id));
    expect(res.deleted).toBe(true);
  });

  it('refuses to delete a referenced policy', async () => {
    const id = createdPolicyIds[0];
    const item = await asAdmin((ctx) => catalog.createItem(ctx, { key: `sla_ref_${suffix}`, name: 'SLA ref', slaPolicyId: id }));
    createdItemIds.push(item.id);
    await expect(asAdmin((ctx) => policies.deletePolicy(ctx, id))).rejects.toBeInstanceOf(ConflictError);
    const p = await asAdmin((ctx) => policies.getPolicy(ctx, id));
    expect(p.usage.catalogItems).toBe(1);
  });

  it('reports compliance totals without failing on empty data', async () => {
    const c = await asAdmin((ctx) => policies.slaCompliance(ctx, { groupBy: 'priority', customerId }));
    expect(c.groupBy).toBe('priority');
    expect(c.totals.met).toBe(0);
    expect(c.totals.compliancePct).toBeNull();
  });
});

describe('SLA policy contract mapping', () => {
  const today = todayStr();
  let policyId: string;
  let contractA: string;
  let contractB: string;
  let contractC: string;
  let serviceId: string;
  let serviceName: string;
  const newContract = (name: string, customer: string, extra: Record<string, unknown> = {}) =>
    asAdmin((ctx) => contracts.createContract(ctx, { customerId: customer, name, status: 'active', startDate: addDays(today, -10), endDate: addDays(today, 355), ...extra } as Parameters<typeof contracts.createContract>[1]));

  it('assigns contracts to a policy and lists them at contract level', async () => {
    const policy = await asAdmin((ctx) => policies.createPolicy(ctx, { name: `Mapped ${suffix}`, targets: [{ ticketType: 'incident', priorityId: p1, metric: 'response', minutes: 30 }] }));
    createdPolicyIds.push(policy.id);
    policyId = policy.id;
    const svc = await asAdmin((ctx) => services.createService(ctx, { name: `Mapped service ${suffix}` }));
    createdServiceIds.push(svc.id);
    serviceId = svc.id;
    serviceName = svc.name;
    contractA = (await newContract('Alpha', customerId)).id;
    contractB = (await newContract('Beta', customerId)).id;

    const res = await asAdmin((ctx) => policies.assignContracts(ctx, policyId, [contractA, contractB, contractA]));
    expect(res.total).toBe(2);
    expect(res.items.every((i) => i.level === 'contract' && i.serviceNames.length === 0)).toBe(true);
    expect(res.items.map((i) => i.contractId).sort()).toEqual([contractA, contractB].sort());
    expect(res.items[0]).toMatchObject({ customerId, customerName: `Test Customer ${suffix}`, customerCode: `TST${suffix}`.toUpperCase(), status: 'active', statusLabel: 'Active', statusColor: 'green' });
    expect(res.items[0].number).toBeTruthy();
    expect(res.items[0].endDate).toBe(addDays(today, 355));

    const listed = await asAdmin((ctx) => policies.policyContracts(ctx, policyId));
    expect(listed).toEqual(res);
    expect((await asAdmin((ctx) => policies.getPolicy(ctx, policyId))).usage.contracts).toBe(2);
    const audits = await withSystem((tx) => tx.select({ entityId: schema.auditLog.entityId, changes: schema.auditLog.changes }).from(schema.auditLog).where(and(eq(schema.auditLog.action, 'sla_policy.assign'), inArray(schema.auditLog.entityId, [contractA, contractB]))));
    expect(audits).toHaveLength(2);
    expect(audits[0].changes).toEqual({ slaPolicyId: { old: null, new: policyId } });
  });

  it('lists contracts that reference the policy through a service override at service level', async () => {
    contractC = (await newContract('Gamma', customerId, { services: [{ serviceId, slaPolicyId: policyId }] })).id;
    const listed = await asAdmin((ctx) => policies.policyContracts(ctx, policyId));
    expect(listed.total).toBe(3);
    const item = listed.items.find((i) => i.contractId === contractC);
    expect(item?.level).toBe('service');
    expect(item?.serviceNames).toEqual([serviceName]);
    expect(listed.items.filter((i) => i.level === 'contract')).toHaveLength(2);
  });

  it('unassigns a contract and refuses contracts that are not mapped at contract level', async () => {
    const res = await asAdmin((ctx) => policies.unassignContract(ctx, policyId, contractA));
    expect(res.items.some((i) => i.contractId === contractA)).toBe(false);
    expect(res.items.filter((i) => i.level === 'contract').map((i) => i.contractId)).toEqual([contractB]);
    await expect(asAdmin((ctx) => policies.unassignContract(ctx, policyId, contractA))).rejects.toBeInstanceOf(NotFoundError);
    // a service-level reference is not a contract-level assignment
    await expect(asAdmin((ctx) => policies.unassignContract(ctx, policyId, contractC))).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await withSystem((tx) => tx.select({ slaPolicyId: schema.contracts.slaPolicyId }).from(schema.contracts).where(eq(schema.contracts.id, contractA)));
    expect(row.slaPolicyId).toBeNull();
    const audits = await withSystem((tx) => tx.select({ id: schema.auditLog.id }).from(schema.auditLog).where(and(eq(schema.auditLog.action, 'sla_policy.unassign'), eq(schema.auditLog.entityId, contractA))));
    expect(audits).toHaveLength(1);
  });

  it('refuses to assign contracts to an inactive or unknown policy', async () => {
    const inactive = await asAdmin((ctx) => policies.createPolicy(ctx, { name: `Inactive ${suffix}`, isActive: false }));
    createdPolicyIds.push(inactive.id);
    await expect(asAdmin((ctx) => policies.assignContracts(ctx, inactive.id, [contractA]))).rejects.toBeInstanceOf(ValidationError);
    await expect(asAdmin((ctx) => policies.assignContracts(ctx, '00000000-0000-0000-0000-000000000000', [contractA]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(asAdmin((ctx) => policies.assignContracts(ctx, policyId, ['00000000-0000-0000-0000-000000000000']))).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await withSystem((tx) => tx.select({ slaPolicyId: schema.contracts.slaPolicyId }).from(schema.contracts).where(eq(schema.contracts.id, contractA)));
    expect(row.slaPolicyId).toBeNull();
  });

  it('a customer-scoped principal cannot map contracts of another customer', async () => {
    const foreign = await newContract('Foreign', otherCustomerId);
    await expect(runAs(customerUser, { requestId: 'test' }, (ctx) => policies.assignContracts(ctx, policyId, [foreign.id]))).rejects.toThrow();
    const [row] = await withSystem((tx) => tx.select({ slaPolicyId: schema.contracts.slaPolicyId }).from(schema.contracts).where(eq(schema.contracts.id, foreign.id)));
    expect(row.slaPolicyId).toBeNull();
    // mapped contracts of other customers stay invisible as well
    await asAdmin((ctx) => policies.assignContracts(ctx, policyId, [foreign.id]));
    const visible = await runAs(customerUser, { requestId: 'test' }, (ctx) => policies.policyContracts(ctx, policyId));
    expect(visible.items.length).toBeGreaterThan(0);
    expect(visible.items.every((i) => i.customerId === customerId)).toBe(true);
    expect((await asAdmin((ctx) => policies.policyContracts(ctx, policyId))).items.some((i) => i.contractId === foreign.id)).toBe(true);
  });

  it('summarises incident targets per priority and reports compliance per policy', async () => {
    const listed = await asAdmin((ctx) => policies.listPolicies(ctx));
    const p = listed.items.find((x) => x.id === policyId)!;
    expect(p.targetSummary).toEqual([{ priorityId: p1, priorityLabel: expect.stringContaining('P1'), priorityLevel: 1, response: 30, resolution: null }]);
    const c = await asAdmin((ctx) => policies.policyCompliance(ctx, policyId, 30));
    expect(c).toMatchObject({ groupBy: 'metric', policyId, days: 30 });
    expect(c.totals.completed).toBe(0);
    expect(c.totals.compliancePct).toBeNull();
    await expect(asAdmin((ctx) => policies.policyCompliance(ctx, '00000000-0000-0000-0000-000000000000', 30))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Service request catalog', () => {
  it('rejects duplicate form field keys', async () => {
    await expect(
      asAdmin((ctx) => catalog.createItem(ctx, { key: `dup_${suffix}`, name: 'Dup', formSchema: [{ key: 'a', label: 'A', type: 'text' }, { key: 'A', label: 'A again', type: 'text' }] })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects select fields without options and invalid keys', async () => {
    await expect(asAdmin((ctx) => catalog.createItem(ctx, { key: `sel_${suffix}`, name: 'Sel', formSchema: [{ key: 'choice', label: 'Choice', type: 'select', options: [] }] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(asAdmin((ctx) => catalog.createItem(ctx, { key: `badkey_${suffix}`, name: 'Bad', formSchema: [{ key: '1st-field', label: 'Bad', type: 'text' }] }))).rejects.toBeInstanceOf(ValidationError);
    expect(() => catalog.validateFormSchema([{ key: 'ok', label: 'Ok', type: 'select', options: ['x', 'y'] }])).not.toThrow();
  });

  it('customer users only see active, portal-visible items offered to their organization', async () => {
    const global = await asAdmin((ctx) => catalog.createItem(ctx, { key: `vis_global_${suffix}`, name: 'Global item', formSchema: [{ key: 'why', label: 'Why', type: 'textarea', required: true }] }));
    const mine = await asAdmin((ctx) => catalog.createItem(ctx, { key: `vis_mine_${suffix}`, name: 'Mine', customerIds: [customerId] }));
    const theirs = await asAdmin((ctx) => catalog.createItem(ctx, { key: `vis_theirs_${suffix}`, name: 'Theirs', customerIds: [otherCustomerId] }));
    const hidden = await asAdmin((ctx) => catalog.createItem(ctx, { key: `vis_hidden_${suffix}`, name: 'Hidden', portalVisible: false }));
    const inactive = await asAdmin((ctx) => catalog.createItem(ctx, { key: `vis_inactive_${suffix}`, name: 'Inactive', isActive: false }));
    createdItemIds.push(global.id, mine.id, theirs.id, hidden.id, inactive.id);

    const portal = await runAs(customerUser, { requestId: 'test' }, (ctx) => catalog.listItems(ctx));
    const keys = portal.items.map((i) => i.key);
    expect(keys).toContain(global.key);
    expect(keys).toContain(mine.key);
    expect(keys).not.toContain(theirs.key);
    expect(keys).not.toContain(hidden.key);
    expect(keys).not.toContain(inactive.key);
    // internal fields are stripped for portal users
    expect((portal.items[0] as Record<string, unknown>).fulfilmentInstructions).toBeUndefined();
    await expect(runAs(customerUser, { requestId: 'test' }, (ctx) => catalog.getItem(ctx, theirs.id))).rejects.toThrow();

    // MSP users can ask for the portal view of a given customer
    const forCustomer = await asAdmin((ctx) => catalog.listItems(ctx, { portal: true, customerId: otherCustomerId }));
    const forKeys = forCustomer.items.map((i) => i.key);
    expect(forKeys).toContain(theirs.key);
    expect(forKeys).not.toContain(mine.key);
    expect(forKeys).not.toContain(hidden.key);
  });

  it('clones and deletes items, refusing deletion only when tickets reference them', async () => {
    const source = createdItemIds[createdItemIds.length - 1];
    const clone = await asAdmin((ctx) => catalog.cloneItem(ctx, source));
    expect(clone.key.endsWith('_copy')).toBe(true);
    expect(clone.isActive).toBe(false);
    expect(await asAdmin((ctx) => catalog.deleteItem(ctx, clone.id))).toEqual({ deleted: true });
  });

  it('validates submitted form data against a schema', () => {
    const fields = catalog.validateFormSchema([
      { key: 'system', label: 'System', type: 'text', required: true },
      { key: 'level', label: 'Level', type: 'select', options: ['read', 'write'] },
      { key: 'count', label: 'Count', type: 'number' },
      { key: 'laptop', label: 'Laptop', type: 'boolean' },
    ]);
    expect(catalog.validateFormData(fields, { system: 'ERP', level: 'read', count: '3', laptop: 'true' })).toEqual({ system: 'ERP', level: 'read', count: 3, laptop: true });
    expect(() => catalog.validateFormData(fields, { level: 'admin' })).toThrow(ValidationError);
  });
});
