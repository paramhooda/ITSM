/**
 * Field service + preventive maintenance integration tests (DB-backed).
 * Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/field.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import { entitlementUtilization } from '@/modules/contracts/entitlements';
import * as field from '@/modules/field/service';
import * as pm from '@/modules/pm/service';
import { markMissed } from '@/jobs/processors/pm';

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let admin: Principal;
let addedTeamMember = false;
const ids = { customer: '', site: '', service: '', contract: '', siteVisits: '', pmVisits: '', breakdownType: '', pmType: '', team: '' };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);
const d = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!user) throw new Error('admin user missing (seed not applied?)');
    invalidatePrincipal(user.id);
    admin = (await loadPrincipal(user.id))!;
    ids.breakdownType = await optionId(tx, 'field_visit_type', 'breakdown');
    ids.pmType = await optionId(tx, 'field_visit_type', 'preventive_maintenance');
    const siteVisitsType = await optionId(tx, 'entitlement_type', 'site_visits');
    const pmVisitsType = await optionId(tx, 'entitlement_type', 'pm_visits');
    const [team] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.key, 'field')).limit(1);
    ids.team = team?.id ?? '';
    // pm.due / pm.missed notify the program's team: make the admin a member so the outbox receives a row.
    if (team) {
      const inserted = await tx.insert(schema.teamMembers).values({ teamId: team.id, userId: user.id }).onConflictDoNothing().returning({ userId: schema.teamMembers.userId });
      addedTeamMember = inserted.length > 0;
    }
    const [customer] = await tx.insert(schema.customers).values({ code: `FLD${suffix.toUpperCase()}`, name: `Field Test Co ${suffix}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = customer.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: customer.id, code: 'HQ', name: 'Head office', isPrimary: true }).returning();
    ids.site = site.id;
    await tx.insert(schema.contacts).values({ customerId: customer.id, name: 'Primary Contact', email: `contact-${suffix}@example.test`, isPrimary: true });
    const [service] = await tx.insert(schema.services).values({ key: `amc_${suffix}`, name: `AMC ${suffix}`, domain: 'amc' }).returning();
    ids.service = service.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: customer.id, number: `FLD-${suffix}`, name: `AMC contract ${suffix}`, status: 'active', startDate: d(-30), endDate: d(335) }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: customer.id, serviceId: service.id });
    const [sv] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: customer.id, typeId: siteVisitsType, name: 'Site visits', quantity: '12', unit: 'visits', period: 'yearly' }).returning();
    const [pv] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: customer.id, typeId: pmVisitsType, name: 'PM visits', quantity: '4', unit: 'visits', period: 'yearly' }).returning();
    ids.siteVisits = sv.id;
    ids.pmVisits = pv.id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (ids.customer) {
      await tx.delete(schema.timeEntries).where(eq(schema.timeEntries.customerId, ids.customer));
      await tx.delete(schema.tickets).where(eq(schema.tickets.customerId, ids.customer));
      await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.customerId, ids.customer));
      await tx.delete(schema.notifications).where(eq(schema.notifications.customerId, ids.customer));
      await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    }
    if (ids.service) await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
    if (addedTeamMember && ids.team) await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.teamId, ids.team), eq(schema.teamMembers.userId, admin.id)));
  });
  await closeDb();
});

const used = (entitlementId: string) =>
  withSystem(async (tx) => {
    const [ent] = await tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, entitlementId)).limit(1);
    return (await entitlementUtilization(tx, ent!)).used;
  });

describe('field visits', () => {
  let visitId = '';

  it('creates a visit with an FV- number, the covering contract and an auto-picked site_visits entitlement', async () => {
    const v = await asAdmin((ctx) => field.createVisit(ctx, { customerId: ids.customer, siteId: ids.site, serviceId: ids.service, typeId: ids.breakdownType, title: `Replace faulty switch ${suffix}`, purpose: 'Breakdown', checklist: [{ item: 'Power check', required: true }] }));
    visitId = v.id;
    expect(v.number).toMatch(/^FV-\d{6}$/);
    expect(v.status).toBe('requested');
    expect(v.contractId).toBe(ids.contract);
    expect(v.entitlementId).toBe(ids.siteVisits);
    const detail = await asAdmin((ctx) => field.getVisit(ctx, v.id));
    expect((detail as { customerName?: string | null }).customerName).toContain('Field Test Co');
  });

  it('schedules the visit and queues the field_visit.scheduled notification', async () => {
    const v = await asAdmin((ctx) => field.scheduleVisit(ctx, visitId, { scheduledStart: new Date(Date.now() + 86_400_000), scheduledEnd: new Date(Date.now() + 86_400_000 + 2 * 3_600_000), engineerId: admin.id, teamId: ids.team || null }));
    expect(v.status).toBe('scheduled');
    expect(v.engineerId).toBe(admin.id);
    const outbox = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'field_visit.scheduled'), eq(schema.notificationOutbox.entityId, visitId))));
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox[0]!.recipient).toBe(`contact-${suffix}@example.test`);
  });

  it('starts and completes the visit: consumption recorded, time entry created, status completed', async () => {
    const started = await asAdmin((ctx) => field.startVisit(ctx, visitId));
    expect(started.status).toBe('in_progress');
    expect(started.actualStart).not.toBeNull();
    const done = await asAdmin((ctx) => field.completeVisit(ctx, visitId, { workSummary: 'Switch replaced and tested', findings: 'PSU failure', recommendations: 'Add spare', workMinutes: 75, travelMinutes: 30, checklist: [{ item: 'Power check', required: true, done: true, result: 'ok' }] }));
    expect(done.status).toBe('completed');
    expect(done.workMinutes).toBe(75);
    expect(done.consumptionId).not.toBeNull();
    expect(await used(ids.siteVisits)).toBe(1);
    const entries = await withSystem((tx) => tx.select().from(schema.timeEntries).where(eq(schema.timeEntries.fieldVisitId, visitId)));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.workType).toBe('onsite');
    expect(entries[0]!.minutes).toBe(75);
    expect(entries[0]!.userId).toBe(admin.id);
    const completedNotice = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'field_visit.completed'), eq(schema.notificationOutbox.entityId, visitId))));
    expect(completedNotice.length).toBeGreaterThan(0);
    const audit = await withSystem((tx) => tx.execute(sql`SELECT action FROM audit_log WHERE entity_type = 'field_visit' AND entity_id = ${visitId}::uuid`));
    const actions = (audit.rows as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'schedule', 'start', 'complete']));
  });

  it('refuses to cancel a completed visit', async () => {
    await expect(asAdmin((ctx) => field.cancelVisit(ctx, visitId, { reason: 'changed my mind' }))).rejects.toThrow(/completed visit cannot be cancelled/);
  });

  it('records the customer acknowledgement', async () => {
    const v = await asAdmin((ctx) => field.acknowledgeVisit(ctx, visitId, { name: 'Site Manager', title: 'IT Lead', rating: 4 }));
    expect(v.customerAckName).toBe('Site Manager');
    expect(v.customerRating).toBe(4);
    expect(v.customerAckAt).not.toBeNull();
  });
});

describe('preventive maintenance', () => {
  let programId = '';
  let occurrenceId = '';
  let pmVisitId = '';

  it('creates a quarterly program from 2026-01-01 with four occurrences in 2026', async () => {
    const p = await asAdmin((ctx) => pm.createProgram(ctx, { name: `Quarterly PM ${suffix}`, customerId: ids.customer, siteId: ids.site, serviceId: ids.service, frequency: 'quarterly', startDate: '2026-01-01', endDate: '2026-12-31', leadDays: 14, graceDays: 7, checklist: [{ item: 'Clean filters', required: true }, { item: 'Check firmware' }], assignedEngineerId: admin.id, assignedTeamId: ids.team || null }));
    programId = p.id;
    expect(p.contractId).toBe(ids.contract);
    expect(p.entitlementId).toBe(ids.pmVisits);
    const occurrences = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.programId, p.id)));
    const dates = occurrences.map((o) => o.plannedDate).sort();
    expect(dates.filter((x) => x.startsWith('2026-'))).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
    expect(occurrences.every((o) => o.status === 'planned')).toBe(true);
    // idempotent
    const again = await withSystem((tx) => generateAgain(tx, p.id));
    expect(again).toBe(0);
  });

  it('schedules an occurrence and creates the linked PM field visit', async () => {
    const occ = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(and(eq(schema.pmOccurrences.programId, programId), eq(schema.pmOccurrences.plannedDate, '2026-10-01'))));
    occurrenceId = occ[0]!.id;
    const scheduled = await asAdmin((ctx) => pm.scheduleOccurrence(ctx, occurrenceId, { scheduledDate: d(3), engineerId: admin.id, createVisit: true }));
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.fieldVisitId).toBeTruthy();
    pmVisitId = scheduled.fieldVisitId!;
    const visit = await withSystem(async (tx) => (await tx.select().from(schema.fieldVisits).where(eq(schema.fieldVisits.id, pmVisitId)))[0]!);
    expect(visit.typeId).toBe(ids.pmType);
    expect(visit.pmOccurrenceId).toBe(occurrenceId);
    expect(visit.entitlementId).toBe(ids.pmVisits);
    expect(visit.title).toContain('PM:');
    expect(visit.checklist).toHaveLength(2);
    // 10:00 in Asia/Kolkata = 04:30 UTC
    expect(visit.scheduledStart?.toISOString()).toBe(`${d(3)}T04:30:00.000Z`);
    const notice = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'pm.scheduled'), eq(schema.notificationOutbox.entityId, occurrenceId))));
    expect(notice.length).toBeGreaterThan(0);
  });

  it('completing the PM visit completes the occurrence and consumes a pm_visits entitlement', async () => {
    await asAdmin((ctx) => field.startVisit(ctx, pmVisitId));
    const done = await asAdmin((ctx) => field.completeVisit(ctx, pmVisitId, { workSummary: 'Quarterly PM performed', workMinutes: 60, checklist: [{ item: 'Clean filters', required: true, done: true, result: 'ok' }, { item: 'Check firmware', done: true, result: 'ok' }] }));
    expect(done.status).toBe('completed');
    const [occ] = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, occurrenceId)));
    expect(occ!.status).toBe('completed');
    expect(occ!.completedAt).not.toBeNull();
    expect(occ!.checklistResults).toHaveLength(2);
    expect(await used(ids.pmVisits)).toBe(1);
    expect(await used(ids.siteVisits)).toBe(1); // untouched by the PM visit
  });

  it('markMissed flags an occurrence past its grace period and queues pm.missed', async () => {
    const [jan] = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(and(eq(schema.pmOccurrences.programId, programId), eq(schema.pmOccurrences.plannedDate, '2026-01-01'))));
    expect(jan!.status).toBe('planned');
    // 2026-01-05: within grace (7 days) → still planned
    await markMissed(new Date('2026-01-05T06:00:00Z'));
    let [row] = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, jan!.id)));
    expect(row!.status).toBe('planned');
    // 2026-01-10: planned 01-01 + 7 grace days < 01-10 → missed
    const result = await markMissed(new Date('2026-01-10T06:00:00Z'));
    expect(result.missed).toBeGreaterThan(0);
    [row] = await withSystem((tx) => tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, jan!.id)));
    expect(row!.status).toBe('missed');
    const missedNotice = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'pm.missed'), eq(schema.notificationOutbox.entityId, jan!.id))));
    expect(missedNotice.length).toBeGreaterThan(0);
    const audit = await withSystem((tx) => tx.execute(sql`SELECT action, source FROM audit_log WHERE entity_type = 'pm_occurrence' AND entity_id = ${jan!.id}::uuid AND action = 'missed'`));
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { source: string }).source).toBe('system');
  });

  it('summary reports the counts and the completed-on-time percentage', async () => {
    const s = await asAdmin((ctx) => pm.pmSummary(ctx, { customerId: ids.customer, from: '2026-01-01', to: '2026-12-31' }));
    expect(s.counts.completed).toBe(1);
    expect(s.counts.missed).toBe(1);
    expect(s.counts.total).toBe(4);
    expect(s.perCustomer[0]?.customerId).toBe(ids.customer);
  });

  it('deactivates instead of deleting a program with completed occurrences', async () => {
    const r = await asAdmin((ctx) => pm.deleteProgram(ctx, programId));
    expect(r).toEqual({ deactivated: true });
    const stillThere = await withSystem((tx) => tx.select({ id: schema.pmPrograms.id, isActive: schema.pmPrograms.isActive }).from(schema.pmPrograms).where(inArray(schema.pmPrograms.id, [programId])));
    expect(stillThere[0]?.isActive).toBe(false);
  });
});

async function generateAgain(tx: Tx, programId: string) {
  const [program] = await tx.select().from(schema.pmPrograms).where(eq(schema.pmPrograms.id, programId)).limit(1);
  return (await pm.generateOccurrences(tx, program!)).created;
}
