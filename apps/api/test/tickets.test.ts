import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, type Principal } from '../src/core/principal';
import { createTicket, changeStatus, resolveTicket, getTicket } from '../src/modules/tickets/service';
import { addComment, timeline } from '../src/modules/tickets/activity';
import { slaSummary } from '../src/modules/sla/engine';

/**
 * DB-backed tests for the ticket + SLA engine. Requires the dev environment
 * (DATABASE_URL etc.) with migrations and the default seed applied.
 */
const suffix = Math.random().toString(36).slice(2, 8);
const ids = { customerId: '', siteId: '', serviceId: '', contractId: '', p1: '', p4: '', pendingCustomer: '', inProgress: '' };
let admin: Principal;
const createdTicketIds: string[] = [];

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}` }, fn);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p4 = await optionId(tx, 'ticket_priority', 'p4');
    ids.pendingCustomer = await optionId(tx, 'ticket_status', 'pending_customer');
    ids.inProgress = await optionId(tx, 'ticket_status', 'in_progress');
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [customer] = await tx.insert(schema.customers).values({ code: `TST${suffix.toUpperCase()}`, name: `Test Customer ${suffix}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customerId = customer.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: customer.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.siteId = site.id;
    const [service] = await tx.insert(schema.services).values({ key: `svc_${suffix}`, name: `Service ${suffix}`, domain: 'noc' }).returning();
    ids.serviceId = service.id;
    const today = new Date();
    const d = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const [contract] = await tx.insert(schema.contracts).values({ customerId: customer.id, number: `TST-${suffix}`, name: `Contract ${suffix}`, status: 'active', startDate: d(-10), endDate: d(355), slaPolicyId: policy?.id ?? null }).returning();
    ids.contractId = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: customer.id, serviceId: service.id });
    await tx.insert(schema.scopeItems).values({ contractId: contract.id, customerId: customer.id, serviceId: service.id, name: 'All network devices', classification: 'in_scope' });
    const p = await loadPrincipal(adminUser.id);
    if (!p) throw new Error('could not load admin principal');
    admin = p;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdTicketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTicketIds));
    if (ids.customerId) await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customerId));
    if (ids.serviceId) await tx.delete(schema.services).where(eq(schema.services.id, ids.serviceId));
  });
  await closeDb();
});

describe('tickets + SLA engine', () => {
  let ticketId = '';

  it('creates a P1 incident with a formatted number, in-scope classification and 24x7 SLA clocks', async () => {
    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customerId, siteId: ids.siteId, serviceId: ids.serviceId, title: `Core switch down ${suffix}`, description: 'Outage', priorityId: ids.p1 }));
    createdTicketIds.push(t.id);
    ticketId = t.id;
    expect(t.number).toMatch(/^INC-\d{6}$/);
    expect(t.scopeStatus).toBe('in_scope');
    expect(t.contractId).toBe(ids.contractId);
    expect(t.scopeContractId).toBe(ids.contractId);

    const slas = await withSystem((tx) => slaSummary(tx, t.id));
    const metrics = slas.map((s) => s.metric).sort();
    expect(metrics).toEqual(['acknowledgement', 'resolution', 'response', 'restoration']);
    const response = slas.find((s) => s.metric === 'response')!;
    expect(response.state).toBe('running');
    expect(response.calendarTime).toBe(true);
    // P1 response = 30 minutes on a 24x7 clock
    expect(response.dueAt.getTime() - t.createdAt.getTime()).toBe(30 * 60_000);
    const restoration = slas.find((s) => s.metric === 'restoration')!;
    expect(restoration.dueAt.getTime() - t.createdAt.getTime()).toBe(240 * 60_000);
    // ticket.due_at mirrors the earliest open resolution/restoration clock
    expect(t.dueAt?.getTime()).toBe(restoration.dueAt.getTime());

    const detail = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(detail.status?.key).toBe('new');
    expect(detail.priority?.key).toBe('p1');
  });

  it('pauses SLA clocks in a pausing status and resumes with the paused time added', async () => {
    const paused = await asAdmin((ctx) => changeStatus(ctx, ticketId, { statusId: ids.pendingCustomer }));
    expect(paused.statusId).toBe(ids.pendingCustomer);
    const pausedRows = await withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticketId)));
    for (const r of pausedRows) {
      expect(r.state).toBe('paused');
      expect(r.pausedAt).not.toBeNull();
    }
    const before = new Map(pausedRows.map((r) => [r.metric, r.dueAt.getTime()]));
    // Pretend the ticket sat with the customer for 10 minutes.
    await withSystem((tx) => tx.update(schema.ticketSlas).set({ pausedAt: sql`now() - interval '10 minutes'` }).where(eq(schema.ticketSlas.ticketId, ticketId)));

    const resumed = await asAdmin((ctx) => changeStatus(ctx, ticketId, { statusId: ids.inProgress }));
    expect(resumed.statusId).toBe(ids.inProgress);
    const rows = await withSystem((tx) => tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticketId)));
    for (const r of rows) {
      expect(r.state).toBe('running');
      expect(r.pausedAt).toBeNull();
      expect(r.pausedMinutes).toBe(10);
      expect(r.dueAt.getTime()).toBe(before.get(r.metric)! + 10 * 60_000);
    }
    const events = await withSystem((tx) => tx.select().from(schema.ticketSlaEvents).where(inArray(schema.ticketSlaEvents.ticketSlaId, rows.map((r) => r.id))));
    expect(events.some((e) => e.eventType === 'paused')).toBe(true);
    expect(events.some((e) => e.eventType === 'resumed')).toBe(true);
  });

  it('completes response on the first public engineer comment', async () => {
    await asAdmin((ctx) => addComment(ctx, ticketId, { kind: 'comment', body: 'Looking into it' }));
    const slas = await withSystem((tx) => slaSummary(tx, ticketId));
    expect(slas.find((s) => s.metric === 'response')?.state).toBe('met');
    expect(slas.find((s) => s.metric === 'acknowledgement')?.state).toBe('met');
    expect(slas.find((s) => s.metric === 'resolution')?.state).toBe('running');
    const t = await withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)))[0]!);
    expect(t.firstResponseAt).not.toBeNull();
  });

  it('resolves the ticket and marks resolution/restoration as met', async () => {
    const t = await asAdmin((ctx) => resolveTicket(ctx, ticketId, { resolutionNotes: 'Replaced PSU' }));
    expect(t.resolvedAt).not.toBeNull();
    expect(t.restoredAt).not.toBeNull();
    const slas = await withSystem((tx) => slaSummary(tx, ticketId));
    expect(slas.find((s) => s.metric === 'resolution')?.state).toBe('met');
    expect(slas.find((s) => s.metric === 'restoration')?.state).toBe('met');
    expect(slas.every((s) => s.completedAt)).toBe(true);
    const detail = await asAdmin((ctx) => getTicket(ctx, ticketId));
    expect(detail.status?.category).toBe('resolved');
    const tl = await asAdmin((ctx) => timeline(ctx, ticketId));
    expect(tl.items.some((i) => i.kind === 'activity' && i.type === 'status' && /Resolved/.test(i.summary ?? ''))).toBe(true);
    expect(tl.items.some((i) => i.kind === 'comment' && i.body === 'Looking into it')).toBe(true);
    const audit = await withSystem((tx) => tx.execute(sql`SELECT action FROM audit_log WHERE entity_type = 'ticket' AND entity_id = ${ticketId}::uuid`));
    const actions = (audit.rows as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('ticket.create');
    expect(actions).toContain('ticket.resolve');
  });

  it('measures a P4 ticket on the business-hours calendar (due later than elapsed time)', async () => {
    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customerId, siteId: ids.siteId, serviceId: ids.serviceId, title: `Printer slow ${suffix}`, priorityId: ids.p4 }));
    createdTicketIds.push(t.id);
    const slas = await withSystem((tx) => slaSummary(tx, t.id));
    const resolution = slas.find((s) => s.metric === 'resolution')!;
    expect(resolution.calendarTime).toBe(false);
    expect(resolution.targetMinutes).toBe(2880);
    // 48 business hours span more than 48 elapsed hours (nights, weekends, holidays).
    expect(resolution.dueAt.getTime()).toBeGreaterThan(t.createdAt.getTime() + 2880 * 60_000);
    const response = slas.find((s) => s.metric === 'response')!;
    expect(response.dueAt.getTime()).toBeGreaterThanOrEqual(t.createdAt.getTime() + 480 * 60_000);
    // No acknowledgement / restoration targets for P4 in the standard policy
    expect(slas.map((s) => s.metric).sort()).toEqual(['resolution', 'response']);
  });
});
