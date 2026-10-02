/**
 * Dashboards + reports integration tests (DB-backed).
 * Run with the dev environment sourced:  npx vitest run test/reports.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, schema, closeDb, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { storage } from '@/lib/storage';
import { createTicket, resolveTicket, setScope } from '@/modules/tickets/service';
import { computeRollups } from '@/jobs/processors/metrics';
import * as dash from '@/modules/dashboards/service';
import * as reports from '@/modules/reports/service';
import * as schedules from '@/modules/reports/schedules';
import { computeNextRun } from '@/modules/reports/schedules';
import { executeSchedule } from '@/jobs/processors/reports';
import { resolveDateRange } from '@/modules/reports/dates';

const suffix = Math.random().toString(36).slice(2, 8);
const ids = { adminUser: '', customerA: '', customerB: '', service: '', contract: '', entitlement: '', p1: '', p2: '', p3: '', p4: '', customerUser: '', schedule: '', mspSchedule: '' };
const tickets: { id: string; number: string; customerId: string }[] = [];
let admin: Principal;
let portalUser: Principal;
const today = new Date().toISOString().slice(0, 10);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalUser, { requestId: `test-${suffix}`, source: 'api' }, fn);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    for (const k of ['p1', 'p2', 'p3', 'p4'] as const) ids[k] = await optionId(tx, 'ticket_priority', k);
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [a] = await tx.insert(schema.customers).values({ code: `RPA${suffix.toUpperCase()}`, name: `Report Customer A ${suffix}`, accountManagerId: adminUser.id }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `RPB${suffix.toUpperCase()}`, name: `Report Customer B ${suffix}` }).returning();
    ids.customerA = a.id;
    ids.customerB = b.id;
    const [service] = await tx.insert(schema.services).values({ key: `rsvc_${suffix}`, name: `Reporting Service ${suffix}`, domain: 'noc' }).returning();
    ids.service = service.id;
    const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const [contract] = await tx.insert(schema.contracts).values({ customerId: a.id, number: `RPT-${suffix}`, name: `AMC ${suffix}`, status: 'active', startDate: d(-40), endDate: d(60), slaPolicyId: policy?.id ?? null }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: a.id, serviceId: service.id });
    const [ent] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: a.id, name: 'Engineering hours', quantity: '10', unit: 'hours', period: 'contract', warnThresholdPct: 50 }).returning();
    ids.entitlement = ent.id;
    await tx.insert(schema.entitlementConsumptions).values([
      { entitlementId: ent.id, customerId: a.id, quantity: '4', sourceType: 'manual', notes: 'visit 1' },
      { entitlementId: ent.id, customerId: a.id, quantity: '2.5', sourceType: 'manual', notes: 'visit 2' },
    ]);
    await tx.insert(schema.contacts).values({ customerId: a.id, name: 'Primary Contact', email: `primary-${suffix}@customer.test`, isPrimary: true });
    // customer portal user (customer_admin role → portal:reports)
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_admin')).limit(1);
    const [cu] = await tx.insert(schema.users).values({ email: `portal-${suffix}@customer.test`, name: `Portal User ${suffix}`, userType: 'customer', customerId: a.id, status: 'active' }).returning();
    ids.customerUser = cu.id;
    await tx.insert(schema.userRoles).values({ userId: cu.id, roleId: role.id, customerId: null });
    ids.adminUser = adminUser.id;
  });
  // principals resolve through the shared pool, so load them after the setup transaction committed
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portalUser = (await loadPrincipal(ids.customerUser))!;
  await asAdmin(async (ctx) => {
    const mk = async (customerId: string, priorityId: string, type: 'incident' | 'request', title: string) => {
      const t = await createTicket(ctx, { type, customerId, serviceId: ids.service, title: `${title} ${suffix}`, priorityId });
      tickets.push({ id: t.id, number: t.number, customerId });
      return t;
    };
    const t1 = await mk(ids.customerA, ids.p1, 'incident', 'Core switch down');
    const t2 = await mk(ids.customerA, ids.p3, 'incident', 'Printer offline');
    await mk(ids.customerA, ids.p4, 'request', 'New mailbox');
    const oos = await mk(ids.customerA, ids.p3, 'incident', 'Home router support');
    await mk(ids.customerB, ids.p2, 'incident', 'Firewall HA failover');
    await setScope(ctx, oos.id, { scopeStatus: 'out_of_scope', scopeNote: 'Not covered by AMC' });
    await resolveTicket(ctx, t1.id, { resolutionNotes: 'Replaced PSU' });
    await resolveTicket(ctx, t2.id, { resolutionNotes: 'Reconnected' });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    const customerIds = [ids.customerA, ids.customerB].filter(Boolean);
    const runs = await tx.select({ id: schema.reportRuns.id, attachmentId: schema.reportRuns.attachmentId }).from(schema.reportRuns).where(sql`${schema.reportRuns.customerId} = ANY(ARRAY[${sql.join(customerIds.map((c) => sql`${c}::uuid`), sql`, `)}]::uuid[]) OR ${schema.reportRuns.scheduleId} IN (${sql.join([ids.schedule, ids.mspSchedule].filter(Boolean).map((s) => sql`${s}::uuid`), sql`, `)})`);
    const attIds = runs.map((r) => r.attachmentId).filter((x): x is string => !!x);
    if (attIds.length) {
      const atts = await tx.select().from(schema.attachments).where(inArray(schema.attachments.id, attIds));
      for (const a of atts) await storage.delete(a.storageKey).catch(() => undefined);
      await tx.delete(schema.attachments).where(inArray(schema.attachments.id, attIds));
    }
    if (runs.length) await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.entityId, runs.map((r) => r.id)));
    if (runs.length) await tx.delete(schema.reportRuns).where(inArray(schema.reportRuns.id, runs.map((r) => r.id)));
    if (ids.mspSchedule) await tx.delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, ids.mspSchedule));
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets.map((t) => t.id)));
    if (ids.customerUser) await tx.delete(schema.users).where(eq(schema.users.id, ids.customerUser));
    if (customerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    if (ids.service) await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
    await tx.delete(schema.metricRollupsDaily).where(sql`${schema.metricRollupsDaily.customerId} IS NULL AND false`);
  });
  await closeDb();
});

describe('dashboards', () => {
  it('management KPIs are consistent with live data after computing today\'s rollups', async () => {
    await withSystem((tx) => computeRollups(tx, today));
    const [rollup] = await withSystem((tx) => tx.select().from(schema.metricRollupsDaily).where(and(eq(schema.metricRollupsDaily.day, today), eq(schema.metricRollupsDaily.customerId, ids.customerA))).limit(1));
    expect(rollup).toBeTruthy();
    expect(rollup.metrics.opened).toBe(4);
    expect(rollup.metrics.resolved).toBe(2);
    expect(rollup.metrics.outOfScope).toBe(1);

    const m = await asAdmin((ctx) => dash.management(ctx, { days: 30, customerId: ids.customerA }));
    expect(m.kpis.openedToday).toBe(4);
    expect(m.kpis.ticketsOpened).toBeGreaterThanOrEqual(4);
    expect(m.kpis.ticketsResolved).toBeGreaterThanOrEqual(2);
    expect(m.kpis.openNow).toBe(2);
    expect(m.kpis.outOfScopeCount).toBeGreaterThanOrEqual(1);
    expect(m.kpis.contractsActive).toBe(1);
    expect(m.kpis.contractsExpiring90d).toBe(1);
    expect(m.series.length).toBe(30);
    expect(m.series[m.series.length - 1]!.day).toBe(today);
    expect(m.byService.find((s) => s.name === `Reporting Service ${suffix}`)?.tickets).toBe(4);
    expect(m.entitlementAlerts.some((e) => e.id === ids.entitlement)).toBe(true); // 6.5/10 = 65% > 50% threshold
    expect(m.outOfScopeByCustomer[0]?.id).toBe(ids.customerA);
    expect(m.trends.opened.current).toBe(m.kpis.ticketsOpened);
  });

  it('7-day management view uses live series and still reports today', async () => {
    const m = await asAdmin((ctx) => dash.management(ctx, { days: 7, customerId: ids.customerA }));
    expect(m.series.length).toBe(7);
    expect(m.series[6]!.opened).toBe(4);
    expect(m.kpis.ticketsOpened).toBe(4);
  });

  it('NOC and engineer views load', async () => {
    const n = await asAdmin((ctx) => dash.noc(ctx));
    expect(n.totals.open).toBeGreaterThanOrEqual(3);
    expect(n.aging.map((a) => a.bucket)).toEqual(['< 4h', '4-24h', '1-3d', '> 3d']);
    expect(n.openIncidents.reduce((s, r) => s + Number(r.count), 0)).toBeGreaterThanOrEqual(2);
    const e = await asAdmin((ctx) => dash.engineer(ctx));
    expect(e.assigned).toBeDefined();
    expect(Array.isArray(e.knowledge)).toBe(true);
  });

  it('customer dashboard for a portal user returns only their own data', async () => {
    const c = await asPortal((ctx) => dash.customer(ctx));
    expect(c.customer.id).toBe(ids.customerA);
    expect(c.tickets.open).toBe(2);
    expect(c.tickets.resolved30d).toBe(2);
    expect(c.recentTickets.length).toBe(4);
    expect(c.recentTickets.every((t) => t.customer_id === ids.customerA)).toBe(true);
    expect(c.contracts.length).toBe(1);
    expect(c.entitlements[0]?.used).toBe(6.5);
    expect(c.serviceTeam.accountManager?.name).toBe(admin.name);
    expect(c.sla.days30.totals).toBeDefined();
    // trends for a portal user are pinned to their customer
    const t = await asPortal((ctx) => dash.trends(ctx, { customerId: ids.customerB, from: today, to: today }));
    expect(t.customerId).toBe(ids.customerA);
    expect(t.series[0]!.opened).toBe(4);
  });
});

describe('report definitions', () => {
  it('sla_performance returns per-priority/metric rows with a compliance summary', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'sla_performance', parameters: { customerId: ids.customerA, dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.rows.length).toBeGreaterThan(0);
    expect(out.result.rows[0]).toHaveProperty('priority');
    expect(out.result.rows[0]).toHaveProperty('metric');
    expect(out.result.summary?.find((s) => s.label === 'Overall compliance')).toBeTruthy();
    const resolution = out.result.rows.filter((r) => r.metric === 'Resolution');
    expect(resolution.reduce((s, r) => s + Number(r.met), 0)).toBe(2);
  });

  it('amc_utilization reflects entitlement consumption', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'amc_utilization', parameters: { customerId: ids.customerA, dateRange: 'last_30_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    const row = out.result.rows.find((r) => r.id === ids.entitlement);
    expect(row).toBeTruthy();
    expect(row!.used).toBe(6.5);
    expect(row!.remaining).toBe(3.5);
    expect(row!.status).toBe('warning');
    expect(out.result.sections?.[0]?.rows.length).toBe(2);
  });

  it('out_of_scope_activity lists the flagged ticket', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'out_of_scope_activity', parameters: { customerId: ids.customerA, dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    const oos = tickets.find((t) => t.number && t.customerId === ids.customerA && out.result.rows.some((r) => r.number === t.number && r.scope_status === 'out_of_scope'));
    expect(oos).toBeTruthy();
    expect(out.result.summary?.find((s) => s.label === 'Out of scope')?.value).toBe(1);
  });

  it('runs a report as CSV: stores the attachment and a completed run row', async () => {
    const run = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'open_tickets', parameters: { customerId: ids.customerA }, format: 'csv' }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.status).toBe('completed');
    expect(run.rowCount).toBe(2);
    expect(run.attachmentId).toBeTruthy();
    expect(run.filename).toMatch(/\.csv$/);
    expect(run.customerId).toBe(ids.customerA);
    const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, run.attachmentId!)).limit(1));
    expect(att.entityType).toBe('report_run');
    expect(att.customerId).toBe(ids.customerA);
    expect(att.docType).toBe('report');
    const csv = (await storage.get(att.storageKey)).toString('utf8');
    expect(csv.split('\n')[0]).toContain('Number');
    expect(csv).toContain(tickets.find((t) => t.customerId === ids.customerA && t.number)!.number.slice(0, 3));
    const html = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_report', parameters: { customerId: ids.customerA, dateRange: 'last_30_days' }, format: 'html' }));
    if (!('status' in html)) throw new Error('expected run');
    const [hatt] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, html.attachmentId!)).limit(1));
    const body = (await storage.get(hatt.storageKey)).toString('utf8');
    expect(body).toContain('<svg');
    expect(body).toContain('Monthly service report');
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'report_run'), eq(schema.auditLog.entityId, run.id))));
    expect(audit.some((a) => a.action === 'create')).toBe(true);
  });
});

describe('schedules', () => {
  it('computes nextRunAt for daily/weekly/monthly/quarterly/cron in the schedule timezone', () => {
    const from = new Date('2026-03-04T10:00:00Z'); // Wednesday
    const daily = computeNextRun({ frequency: 'daily', timezone: 'Asia/Kolkata' }, from);
    expect(daily.toISOString()).toBe('2026-03-05T01:30:00.000Z'); // 07:00 IST
    const weekly = computeNextRun({ frequency: 'weekly', timezone: 'UTC' }, from);
    expect(weekly.toISOString()).toBe('2026-03-09T07:00:00.000Z'); // Monday
    const monthly = computeNextRun({ frequency: 'monthly', timezone: 'UTC' }, from);
    expect(monthly.toISOString()).toBe('2026-04-01T07:00:00.000Z');
    const quarterly = computeNextRun({ frequency: 'quarterly', timezone: 'UTC' }, from);
    expect(quarterly.toISOString()).toBe('2026-04-01T07:00:00.000Z');
    const cron = computeNextRun({ frequency: 'cron', cronExpression: '30 6 * * 1-5', timezone: 'Europe/London' }, from);
    expect(cron.toISOString()).toBe('2026-03-05T06:30:00.000Z');
    expect(() => computeNextRun({ frequency: 'cron', cronExpression: 'not a cron' })).toThrow();
  });

  it('resolves date range presets', () => {
    const r = resolveDateRange('last_month', {}, '2026-03-15');
    expect(r).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveDateRange('last_quarter', {}, '2026-05-10')).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolveDateRange('custom', { from: '2026-01-05', to: '2026-01-07' })).toMatchObject({ from: '2026-01-05', to: '2026-01-07' });
    expect(() => resolveDateRange('custom', { from: '2026-02-01', to: '2026-01-01' })).toThrow();
  });

  it('creates a schedule with a computed next run and executes it end-to-end (runs + outbox email with attachment)', async () => {
    const s = await asAdmin((ctx) => schedules.createSchedule(ctx, { name: `Weekly SLA ${suffix}`, reportKey: 'sla_performance', customerId: ids.customerA, recipients: [`manager-${suffix}@msp.test`], recipientUserIds: [admin.id], frequency: 'weekly', timezone: 'Asia/Kolkata', dateRange: 'last_7_days', filters: { customerContacts: true }, format: 'both', delivery: 'both', isActive: true }));
    ids.schedule = s.id;
    expect(s.nextRunAt).toBeTruthy();
    expect(new Date(s.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(s.nextRunAt!).getUTCDay()).toBe(1);

    const out = await executeSchedule(s.id, { manual: true, requestedBy: admin.id });
    expect(out).toMatchObject({ targets: 1, runs: 2, failures: [] });
    const runs = await withSystem((tx) => tx.select().from(schema.reportRuns).where(eq(schema.reportRuns.scheduleId, s.id)));
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'completed' && r.customerId === ids.customerA && r.portalVisible && r.attachmentId)).toBe(true);
    expect(runs[0]!.deliveredTo.sort()).toEqual([admin.email.toLowerCase(), `manager-${suffix}@msp.test`, `primary-${suffix}@customer.test`].sort());
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'report.delivered'), inArray(schema.notificationOutbox.entityId, runs.map((r) => r.id)))));
    expect(mails.length).toBe(3);
    expect(mails[0]!.attachments.length).toBe(2);
    expect(mails[0]!.attachments.map((a) => a.contentType).sort()).toEqual(['text/csv', 'text/html']);
    expect(mails[0]!.subject).toContain('SLA performance');
    expect(mails[0]!.customerId).toBe(ids.customerA);
    const [after] = await withSystem((tx) => tx.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, s.id)).limit(1));
    expect(after.lastRunAt).toBeTruthy();

    // MSP-wide schedule fanned out per active customer
    const m = await asAdmin((ctx) => schedules.createSchedule(ctx, { name: `Per-customer open tickets ${suffix}`, reportKey: 'open_tickets', customerId: null, recipients: [`ops-${suffix}@msp.test`], recipientUserIds: [], frequency: 'daily', timezone: 'UTC', dateRange: 'last_day', filters: { perCustomer: true }, format: 'csv', delivery: 'email', isActive: true }));
    ids.mspSchedule = m.id;
    const fan = await executeSchedule(m.id, { manual: true });
    expect(fan.targets).toBeGreaterThanOrEqual(2);
    const fanRuns = await withSystem((tx) => tx.select().from(schema.reportRuns).where(eq(schema.reportRuns.scheduleId, m.id)));
    expect(fanRuns.some((r) => r.customerId === ids.customerA)).toBe(true);
    expect(fanRuns.some((r) => r.customerId === ids.customerB)).toBe(true);
    await asAdmin((ctx) => schedules.deleteSchedule(ctx, m.id));
    ids.mspSchedule = '';
  });

  it('rejects schedules without recipients for email delivery and validates cron/timezone', async () => {
    await expect(asAdmin((ctx) => schedules.createSchedule(ctx, { name: 'x', reportKey: 'open_tickets', recipients: [], recipientUserIds: [], frequency: 'daily', timezone: 'UTC', dateRange: 'last_day', filters: {}, format: 'csv', delivery: 'email', isActive: true }))).rejects.toThrow(/recipient/);
    await expect(asAdmin((ctx) => schedules.createSchedule(ctx, { name: 'x', reportKey: 'open_tickets', recipients: ['a@b.c'], recipientUserIds: [], frequency: 'cron', cronExpression: '* * * * *', timezone: 'UTC', dateRange: 'last_day', filters: {}, format: 'csv', delivery: 'email', isActive: true }))).rejects.toThrow(/hourly/);
    await expect(asAdmin((ctx) => schedules.createSchedule(ctx, { name: 'x', reportKey: 'open_tickets', recipients: ['a@b.c'], recipientUserIds: [], frequency: 'daily', timezone: 'Mars/Olympus', dateRange: 'last_day', filters: {}, format: 'csv', delivery: 'email', isActive: true }))).rejects.toThrow(/timezone/);
  });
});

describe('customer portal isolation', () => {
  it('a customer user only sees portal definitions, own runs and own rows', async () => {
    const defs = await asPortal((ctx) => reports.listDefinitions(ctx));
    expect(defs.items.length).toBeGreaterThan(0);
    expect(defs.items.every((d) => d.portal)).toBe(true);
    expect(defs.items.some((d) => d.key === 'audit_activity')).toBe(false);
    expect(defs.customerId).toBe(ids.customerA);

    // customerId parameter is ignored: the run is pinned to the user's own customer
    const preview = await asPortal((ctx) => reports.runReport(ctx, { reportKey: 'open_tickets', parameters: { customerId: ids.customerB } }));
    if (!('result' in preview)) throw new Error('expected preview');
    expect(preview.parameters.customerId).toBe(ids.customerA);
    const bNumber = tickets.find((t) => t.customerId === ids.customerB)!.number;
    expect(preview.result.rows.some((r) => r.number === bNumber)).toBe(false);
    expect(preview.result.rows.length).toBe(2);

    await expect(asPortal((ctx) => reports.runReport(ctx, { reportKey: 'audit_activity', parameters: {} }))).rejects.toThrow();

    // runs: only portal-visible ones of their customer (the scheduled runs above are portal visible; the admin's ad-hoc csv is not)
    const runs = await asPortal((ctx) => reports.listRuns(ctx, {}));
    expect(runs.items.length).toBeGreaterThanOrEqual(2);
    expect(runs.items.every((r) => r.customerId === ids.customerA && r.portalVisible)).toBe(true);
    const adminRuns = await asAdmin((ctx) => reports.listRuns(ctx, { customerId: ids.customerA }));
    expect(adminRuns.items.length).toBeGreaterThan(runs.items.length);
    const hidden = adminRuns.items.find((r) => !r.portalVisible)!;
    await expect(asPortal((ctx) => reports.getRun(ctx, hidden.id))).rejects.toThrow();

    // a portal user cannot manage schedules
    await expect(asPortal((ctx) => schedules.listSchedules(ctx))).rejects.toThrow();
  });

  it('customer users running a stored report get a portal-visible, customer-scoped file', async () => {
    const run = await asPortal((ctx) => reports.runReport(ctx, { reportKey: 'ticket_volume', parameters: { dateRange: 'last_7_days' }, format: 'csv', portalVisible: true }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.customerId).toBe(ids.customerA);
    expect(run.portalVisible).toBe(true);
    const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, run.attachmentId!)).limit(1));
    expect(att.customerVisible).toBe(true);
    expect(att.customerId).toBe(ids.customerA);
  });
});
