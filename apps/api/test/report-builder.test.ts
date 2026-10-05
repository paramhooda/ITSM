/**
 * The custom report builder: the compiler refuses anything outside the field
 * catalogue (including injection attempts on field names, operators, sort keys
 * and values); a saved report is seen by its owner, the roles and teams it is
 * shared with and report managers, needs the entity's read permission, runs and
 * schedules like a built-in through its custom:<id> key, honours the row cap and
 * the statement time limit, keeps internal fields and other organisations away
 * from the portal, and the "Describe it" suggestion validates whatever the model
 * returns and falls back deterministically.
 * Run with the dev environment sourced: npx vitest run test/report-builder.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql, like } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withSystem, schema, closeDb, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { storage } from '@/lib/storage';
import { createTicket, resolveTicket } from '@/modules/tickets/service';
import * as reports from '@/modules/reports/service';
import * as schedules from '@/modules/reports/schedules';
import { executeSchedule } from '@/jobs/processors/reports';
import * as builder from '@/modules/reports/builder/service';
import { validateSpec, compileSpec, describeSpec } from '@/modules/reports/builder/compile';
import { ENTITIES, ENTITY_KEYS } from '@/modules/reports/builder/catalog';
import { suggest, fallbackSpec } from '@/modules/reports/builder/suggest';
import * as ai from '@/modules/ai/service';
import { availableTools, toolByName } from '@/modules/ai/tools';
import type { ChatResponse } from '@/lib/ai';
import type { ReportSpec } from '@/db/schema/report-definitions';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-rb-${S}`, source: 'api' as const };
const ids = { adminUser: '', customerA: '', customerB: '', service: '', socService: '', contract: '', entitlement: '', team: '', builder: '', engineer: '', teamUser: '', portal: '', p1: '', p3: '', assetA: '', assetB: '', socTicket: '' };
const tickets: { id: string; number: string; customerId: string; type: string }[] = [];
const definitionIds: string[] = [];
const scheduleIds: string[] = [];
let admin: Principal;
let builderUser: Principal;
let engineer: Principal;
let teamUser: Principal;
let portalUser: Principal;
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
const as = (p: () => Principal) => <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(p(), meta, fn);
const asAdmin = as(() => admin);
const asBuilder = as(() => builderUser);
const asEngineer = as(() => engineer);
const asTeamUser = as(() => teamUser);
const asPortal = as(() => portalUser);
const dialect = new PgDialect();
const fakeCtx = (soc: boolean) => ({ user: { userType: 'msp', isSystem: false }, can: (p: string) => (p === 'soc:read' ? soc : true) }) as unknown as Ctx;
const spec = (s: Partial<ReportSpec>): ReportSpec => ({ columns: [], filters: [], match: 'all', groupBy: [], aggregates: [], sort: null, dateField: null, rowLimit: null, chart: null, ...s });
/** The service manager holds soc:read and reports:manage; this staff principal builds reports but holds neither. */
const noSoc = (): Principal => throwaway(['tenant:all', 'reports:run', 'reports:build', 'tickets:read', 'ai:use', 'ai:act'], 'noc_engineer');
const throwaway = (perms: string[], roleKey = 'engineer'): Principal => ({ id: '00000000-0000-0000-0000-00000000aaaa', email: `throwaway-${S}@example.test`, name: 'Throwaway', phone: null, userType: 'msp', customerId: null, status: 'active', timezone: 'UTC', preferences: {}, globalPermissions: new Set(perms as never[]), customerPermissions: new Map(), customerScope: 'all', roles: [{ id: 'r', key: roleKey, name: roleKey, customerId: null }], teams: [], areas: null });

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}
async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
async function reload(id: string) {
  invalidatePrincipal(id);
  return (await loadPrincipal(id))!;
}
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.update(schema.systemSettings).set({ value }).where(eq(schema.systemSettings.key, key)));
const customerNameA = `Report Builder A ${S}`;
const customerNameB = `Report Builder B ${S}`;

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.adminUser = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    const [a] = await tx.insert(schema.customers).values({ code: `RBA${S.toUpperCase()}`, name: customerNameA }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `RBB${S.toUpperCase()}`, name: customerNameB }).returning();
    ids.customerA = a!.id;
    ids.customerB = b!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `rbsvc_${S}`, name: `Builder Service ${S}`, domain: 'noc' }).returning();
    const [soc] = await tx.insert(schema.services).values({ key: `rbsoc_${S}`, name: `Builder SOC Service ${S}`, domain: 'soc' }).returning();
    ids.service = svc!.id;
    ids.socService = soc!.id;
    const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const [contract] = await tx.insert(schema.contracts).values({ customerId: a!.id, number: `RBC-${S}`, name: `AMC ${S}`, status: 'active', startDate: d(-40), endDate: d(60) }).returning();
    ids.contract = contract!.id;
    const [ent] = await tx.insert(schema.contractEntitlements).values({ contractId: contract!.id, customerId: a!.id, name: 'Engineering hours', quantity: '10', unit: 'hours', period: 'contract' }).returning();
    ids.entitlement = ent!.id;
    await tx.insert(schema.entitlementConsumptions).values([
      { entitlementId: ent!.id, customerId: a!.id, quantity: '4', sourceType: 'manual' },
      { entitlementId: ent!.id, customerId: a!.id, quantity: '2.5', sourceType: 'manual' },
    ]);
    const [assetA] = await tx.insert(schema.assets).values({ customerId: a!.id, tag: `RB-A-${S}`, name: `Core switch A ${S}`, lifecycleStage: 'deployed', warrantyEnd: d(30) }).returning();
    const [assetB] = await tx.insert(schema.assets).values({ customerId: b!.id, tag: `RB-B-${S}`, name: `Core switch B ${S}`, lifecycleStage: 'deployed', warrantyEnd: d(90) }).returning();
    ids.assetA = assetA!.id;
    ids.assetB = assetB!.id;
    const [team] = await tx.insert(schema.teams).values({ key: `rb_noc_${S}`, name: `Builder NOC ${S}`, teamType: 'noc' }).returning();
    ids.team = team!.id;
    const mkUser = async (key: string, role: string, extra: Partial<typeof schema.users.$inferInsert> = {}) => {
      const [u] = await tx.insert(schema.users).values({ email: `rb-${key}-${S}@example.test`, name: `${key} ${S}`, userType: 'msp', status: 'active', ...extra }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, role), customerId: null });
      return u!.id;
    };
    ids.builder = await mkUser('builder', 'service_manager');
    ids.engineer = await mkUser('engineer', 'engineer');
    ids.teamUser = await mkUser('teamuser', 'noc_engineer');
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: ids.teamUser });
    ids.portal = await mkUser('portal', 'customer_admin', { userType: 'customer', customerId: a!.id });
  });
  invalidatePrincipal();
  admin = await reload(ids.adminUser);
  builderUser = await reload(ids.builder);
  engineer = await reload(ids.engineer);
  teamUser = await reload(ids.teamUser);
  portalUser = await reload(ids.portal);
  await asAdmin(async (ctx) => {
    const mk = async (customerId: string, priorityId: string, type: 'incident' | 'change', title: string, serviceId = ids.service) => {
      const t = await createTicket(ctx, { type, customerId, serviceId, title: `${title} ${S}`, priorityId });
      tickets.push({ id: t.id, number: t.number, customerId, type });
      return t;
    };
    for (const customerId of [ids.customerA, ids.customerB]) {
      const p1 = await mk(customerId, ids.p1, 'incident', 'Core switch down');
      await mk(customerId, ids.p3, 'incident', 'Printer offline');
      await mk(customerId, ids.p3, 'change', 'Firmware upgrade');
      await resolveTicket(ctx, p1.id, { resolutionNotes: 'Replaced PSU' });
    }
    const soc = await mk(ids.customerA, ids.p3, 'incident', 'Suspicious login', ids.socService);
    ids.socTicket = soc.id;
  });
  const firstA = tickets.find((t) => t.customerId === ids.customerA && t.type === 'incident')!;
  await withSystem((tx) =>
    tx.insert(schema.timeEntries).values([
      { ticketId: firstA.id, customerId: ids.customerA, userId: ids.adminUser, minutes: 90, workType: 'remote', billable: true, startedAt: new Date() },
      { ticketId: ids.socTicket, customerId: ids.customerA, userId: ids.adminUser, minutes: 45, workType: 'remote', billable: false, startedAt: new Date() },
    ]),
  );
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await setSetting('reports.builder.max_rows', 10000);
  await setSetting('ai.disabled_features', []);
  await withSystem(async (tx) => {
    const keys = definitionIds.map((id) => `custom:${id}`);
    const runs = keys.length || scheduleIds.length ? await tx.select({ id: schema.reportRuns.id, attachmentId: schema.reportRuns.attachmentId }).from(schema.reportRuns).where(sql`${schema.reportRuns.reportKey} = ANY(ARRAY[${sql.join([...keys, 'none'].map((k) => sql`${k}`), sql`, `)}]::text[]) OR ${schema.reportRuns.scheduleId} = ANY(ARRAY[${sql.join([...scheduleIds, '00000000-0000-0000-0000-000000000000'].map((s) => sql`${s}::uuid`), sql`, `)}]::uuid[])`) : [];
    const attIds = runs.map((r) => r.attachmentId).filter((x): x is string => !!x);
    if (attIds.length) {
      const atts = await tx.select().from(schema.attachments).where(inArray(schema.attachments.id, attIds));
      for (const a of atts) await storage.delete(a.storageKey).catch(() => undefined);
      await tx.delete(schema.attachments).where(inArray(schema.attachments.id, attIds));
    }
    if (runs.length) await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.entityId, runs.map((r) => r.id)));
    if (runs.length) await tx.delete(schema.reportRuns).where(inArray(schema.reportRuns.id, runs.map((r) => r.id)));
    if (scheduleIds.length) await tx.delete(schema.reportSchedules).where(inArray(schema.reportSchedules.id, scheduleIds));
    await tx.delete(schema.reportDefinitions).where(like(schema.reportDefinitions.name, `%${S}%`));
    if (definitionIds.length) await tx.delete(schema.reportDefinitions).where(inArray(schema.reportDefinitions.id, definitionIds));
    await tx.delete(schema.timeEntries).where(eq(schema.timeEntries.customerId, ids.customerA));
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets.map((t) => t.id)));
    await tx.delete(schema.assets).where(inArray(schema.assets.id, [ids.assetA, ids.assetB]));
    await tx.delete(schema.contracts).where(eq(schema.contracts.id, ids.contract));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.builder, ids.engineer, ids.teamUser, ids.portal]));
    await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.customerA, ids.customerB]));
    await tx.delete(schema.services).where(inArray(schema.services.id, [ids.service, ids.socService]));
  });
  await closeDb();
});

// ---------------------------------------------------------------- the compiler (no database)

describe('spec compilation', () => {
  const tix = ENTITIES.tickets;
  const opts = { portal: false, maxRows: 100 };

  it('refuses anything outside the catalogue and names the field', () => {
    expect(() => validateSpec(tix, spec({ columns: ['number', 'nope'] }), opts)).toThrow(/Unknown field "nope"/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'priority_level', op: 'contains', value: 'x' }] }), opts)).toThrow(/not allowed on Priority level/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer', 'priority', 'status'], aggregates: [{ fn: 'count' }] }), opts)).toThrow(/Invalid report specification/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer'], aggregates: [{ fn: 'sum', field: 'title' }] }), opts)).toThrow(/"title".*cannot be aggregated/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], chart: { type: 'bar', y: ['count'] } }), opts)).toThrow(/chart needs a grouped report/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], rowLimit: 500 }), opts)).toThrow(/Row limit must be between 1 and 100/);
    expect(() => validateSpec(tix, spec({ columns: ['number', 'breach_risk'] }), { portal: true, maxRows: 100 })).toThrow(/breach_risk/);
    expect(() => validateSpec(ENTITIES.problems, spec({ columns: ['number'] }), { portal: true, maxRows: 100 })).toThrow(/cannot be published/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], dateField: 'title' }), opts)).toThrow(/cannot be the period field/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], sort: { key: 'nope', order: 'asc' } }), opts)).toThrow(/Unknown field "nope"/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer'], aggregates: [{ fn: 'count' }], sort: { key: 'sum_minutes', order: 'asc' } }), opts)).toThrow(/neither a group field nor an aggregate/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer'], aggregates: [{ fn: 'sum', field: 'reopen_count' }, { fn: 'sum', field: 'reopen_count', label: 'Again' }] }), opts)).toThrow(/listed twice/);
    expect(() => validateSpec(tix, spec({ groupBy: ['title'], aggregates: [{ fn: 'count' }] }), opts)).toThrow(/cannot be grouped by/);
  });

  it('refuses injection attempts on field names, operators, sort keys, aggregates and values', () => {
    const inj = 'number"; DROP TABLE tickets; --';
    expect(() => validateSpec(tix, spec({ columns: [inj] }), opts)).toThrow(/Unknown field/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'title', op: "eq') OR 1=1 --", value: 'x' }] }), opts)).toThrow(/not allowed/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], sort: { key: inj, order: 'asc' } }), opts)).toThrow(/Unknown field/);
    expect(() => validateSpec(tix, spec({ groupBy: [inj], aggregates: [{ fn: 'count' }] }), opts)).toThrow(/Unknown field/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer'], aggregates: [{ fn: 'sum', field: inj }] }), opts)).toThrow(/Unknown field/);
    expect(() => validateSpec(tix, spec({ groupBy: ['customer'], aggregates: [{ fn: 'drop' as never }] }), opts)).toThrow(/Invalid report specification/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'customer', op: 'in', value: ["x' OR 1=1 --"] }] }), opts)).toThrow(/record ids/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'type', op: 'in', value: ["incident' OR 1=1"] }] }), opts)).toThrow(/unknown value/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'priority_level', op: 'lte', value: '1 OR 1=1' }] }), opts)).toThrow(/a number is required/);
    expect(() => validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'created_at', op: 'last_n_days', value: '7; DROP' }] }), opts)).toThrow(/whole number of days/);
    // a text value is accepted as data: it becomes a bound parameter, never SQL text
    const text = "x'); DROP TABLE tickets; --";
    const ok = validateSpec(tix, spec({ columns: ['number'], filters: [{ field: 'title', op: 'contains', value: text }] }), opts);
    const q = dialect.sqlToQuery(compileSpec(fakeCtx(true), tix, ok, { customerId: null, from: '2026-01-01', to: '2026-01-31' }, { limit: 10, portal: false }).sql);
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toContain(`%x''); DROP TABLE tickets; --%`.replace("''", "'"));
  });

  it('compiles a detail report with only the joins it needs, the customer and period fences and bound parameters', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const s = validateSpec(tix, spec({ columns: ['number', 'customer', 'priority', 'created_at'], filters: [{ field: 'title', op: 'contains', value: 'switch' }, { field: 'priority', op: 'in', value: [uuid] }, { field: 'resolved_at', op: 'is_empty' }], dateField: 'created_at' }), opts);
    const c = compileSpec(fakeCtx(false), tix, s, { customerId: uuid, from: '2026-01-01', to: '2026-01-31' }, { limit: 25, portal: false });
    const q = dialect.sqlToQuery(c.sql);
    expect(q.sql).toContain('FROM tickets t');
    expect(q.sql).toContain('LEFT JOIN customers cu');
    expect(q.sql).toContain('LEFT JOIN config_options pr');
    expect(q.sql).not.toContain('LEFT JOIN services sv');
    expect(q.sql).not.toContain('LEFT JOIN users asg');
    expect(q.sql).toContain("AND t.domain <> 'soc'");
    expect(q.sql).toMatch(/AND t\.customer_id = \$\d+::uuid/);
    expect(q.sql).toMatch(/t\.created_at >= \$\d+::date AND t\.created_at < \$\d+::date \+ interval '1 day'/);
    expect(q.sql).toContain('ILIKE');
    expect(q.sql).toContain('= ANY(ARRAY[');
    expect(q.sql).toContain('t.resolved_at IS NULL');
    expect(q.sql).toMatch(/LIMIT \$\d+$/);
    expect(q.params).toEqual(expect.arrayContaining([uuid, '2026-01-01', '2026-01-31', '%switch%', 25]));
    expect(c.columns.map((x) => x.key)).toEqual(['number', 'customer', 'priority', 'created_at']);
    expect(c.columns[3]!.type).toBe('datetime');
    expect(c.grouped).toBe(false);
    const any = compileSpec(fakeCtx(true), tix, validateSpec(tix, spec({ columns: ['number'], match: 'any', filters: [{ field: 'title', op: 'contains', value: 'a' }, { field: 'title', op: 'contains', value: 'b' }] }), opts), { customerId: null, from: '2026-01-01', to: '2026-01-31' }, { limit: 5, portal: false });
    const aq = dialect.sqlToQuery(any.sql);
    expect(aq.sql).toMatch(/AND \(t\.title ILIKE \$\d+ OR t\.title ILIKE \$\d+\)/);
    expect(aq.sql).not.toContain('customer_id =');
    expect(aq.sql).not.toContain("t.domain <> 'soc'");
  });

  it('compiles a grouped report with positional GROUP BY, deterministic aggregate aliases and typed columns, and describes it in plain words', () => {
    const s = validateSpec(tix, spec({ groupBy: ['customer', 'priority'], aggregates: [{ fn: 'count', label: 'Tickets' }, { fn: 'avg', field: 'resolution_minutes' }], filters: [{ field: 'type', op: 'in', value: ['incident', 'request'] }], dateField: 'created_at', sort: { key: 'count', order: 'desc' }, chart: { type: 'bar', y: ['count', 'avg_resolution_minutes'] } }), opts);
    const c = compileSpec(fakeCtx(true), tix, s, { customerId: null, from: '2026-01-01', to: '2026-01-31' }, { limit: 50, portal: false });
    const q = dialect.sqlToQuery(c.sql);
    expect(q.sql).toContain('GROUP BY 1, 2');
    expect(q.sql).toContain('count(*)::int AS "count"');
    expect(q.sql).toContain('AS "avg_resolution_minutes"');
    expect(q.sql).toContain('ORDER BY "count" DESC');
    expect(q.sql).toContain('::text[]');
    expect(c.grouped).toBe(true);
    expect(c.columns.map((x) => [x.key, x.type])).toEqual([['customer', 'text'], ['priority', 'text'], ['count', 'number'], ['avg_resolution_minutes', 'minutes']]);
    expect(c.columns[2]!.label).toBe('Tickets');
    const cq = dialect.sqlToQuery(c.countSql);
    expect(cq.sql).toMatch(/^SELECT count\(\*\)::int AS n FROM \(/);
    expect(cq.sql).not.toContain('ORDER BY');
    const lines = describeSpec(tix, s);
    expect(lines[0]).toBe('Tickets grouped by Customer and Priority: Tickets, Average resolution time');
    expect(lines).toContain('Filter: Type is any of Incident, Request');
    expect(lines).toContain('Period: Created within the chosen range');
    expect(lines).toContain('Sort: Tickets descending');
    expect(lines).toContain('Chart: bar of count, avg_resolution_minutes by Customer');
  });

  it('exposes twelve entities whose field expressions never come from input', () => {
    expect(ENTITY_KEYS).toHaveLength(12);
    for (const key of ENTITY_KEYS) {
      const e = ENTITIES[key];
      for (const d of e.dateFields) expect(e.fields[d], `${key}.${d}`).toBeDefined();
      for (const c of e.defaultColumns) expect(e.fields[c], `${key}.${c}`).toBeDefined();
      if (e.defaultDateField) expect(e.dateFields).toContain(e.defaultDateField);
      for (const f of Object.values(e.fields)) {
        if (f.type === 'option' || f.type === 'ref') expect(f.filterOn, `${key}.${f.key} filterOn`).toBeDefined();
        if (f.type === 'enum') expect(f.options?.values?.length, `${key}.${f.key} values`).toBeGreaterThan(0);
        for (const j of f.joins ?? []) expect(e.joins[j], `${key}.${f.key} join ${j}`).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------- stored definitions (database)

describe('custom reports', () => {
  let reportId = '';
  let key = '';
  const ticketSpec = (extra: Partial<ReportSpec> = {}) => spec({ columns: ['number', 'customer', 'priority', 'status', 'created_at'], filters: [{ field: 'priority_level', op: 'lte', value: 1 }, { field: 'customer', op: 'in', value: [ids.customerA, ids.customerB] }], dateField: 'created_at', ...extra });

  it('saves a private detail report with an audit entry and the custom:<id> key', async () => {
    const view = await asBuilder((ctx) => builder.createDefinition(ctx, { name: `P1 tickets ${S}`, description: null, category: 'custom', entity: 'tickets', spec: ticketSpec(), defaultDateRange: 'last_30_days', scopeCustomerId: null, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: false, isActive: true }));
    reportId = view.id;
    key = view.key;
    definitionIds.push(reportId);
    expect(key).toBe(`custom:${reportId}`);
    expect(view.ownerName).toBe(`builder ${S}`);
    expect(view.canEdit).toBe(true);
    expect(view.summaryLines[0]).toContain('Tickets: Number, Customer');
    // filter values are described by name, never by id
    const customerLine = view.summaryLines.find((l) => l.startsWith('Filter: Customer'));
    expect(customerLine).toContain(customerNameA);
    expect(customerLine).toContain(customerNameB);
    expect(view.summaryLines.join(' ')).not.toContain(ids.customerB);
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'report_definition'), eq(schema.auditLog.entityId, reportId))));
    expect(audit.some((a) => a.action === 'create')).toBe(true);
    expect(JSON.stringify(audit.find((a) => a.action === 'create')?.metadata)).toContain(customerNameB);
  });

  it('previews the rows of both customers, or one customer, under the caller\'s fences', async () => {
    const both = await asBuilder((ctx) => builder.preview(ctx, { entity: 'tickets', spec: ticketSpec(), parameters: {}, portal: false }));
    expect(both.rowCount).toBe(2);
    expect(both.rows.map((r) => r.customer).sort()).toEqual([customerNameA, customerNameB]);
    expect(both.summary?.[0]).toMatchObject({ label: 'Rows', value: 2 });
    expect(both.summaryLines.length).toBeGreaterThan(1);
    const a = await asBuilder((ctx) => builder.preview(ctx, { entity: 'tickets', spec: ticketSpec(), parameters: { customerId: ids.customerA }, portal: false }));
    expect(a.rowCount).toBe(1);
    expect(a.rows[0]!.customer).toBe(customerNameA);
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'report_definition'), eq(schema.auditLog.action, 'preview'), eq(schema.auditLog.userId, ids.builder))));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('runs through the report runner as JSON and as a stored CSV, counting the runs', async () => {
    const out = await asBuilder((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {}, format: 'json' }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.report.key).toBe(key);
    expect(out.report.custom?.canEdit).toBe(true);
    expect(out.result.rows.length).toBe(2);
    expect(out.result.rowCount).toBe(2);
    const run = await asBuilder((ctx) => reports.runReport(ctx, { reportKey: key, parameters: { customerId: ids.customerA }, format: 'csv' }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.status).toBe('completed');
    expect(run.reportKey).toBe(key);
    expect(run.rowCount).toBe(1);
    expect(run.filename).toMatch(/\.csv$/);
    const [row] = await withSystem((tx) => tx.select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, reportId)));
    expect(row!.runCount).toBeGreaterThanOrEqual(2);
    expect(row!.lastRunAt).toBeTruthy();
    expect((await asBuilder((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key && d.category === 'custom')).toBe(true);
  });

  it('is seen by its owner, then by the team and the role it is shared with; invisible rows are not found, editing needs rights', async () => {
    expect((await asEngineer((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key)).toBe(false);
    await expect(asEngineer((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {} }))).rejects.toMatchObject({ statusCode: 404 });
    await expect(asEngineer((ctx) => builder.getDefinition(ctx, reportId))).rejects.toMatchObject({ statusCode: 404 });
    await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { visibility: 'shared', sharedTeamIds: [ids.team] }));
    expect((await asTeamUser((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key)).toBe(true);
    const teamRun = await asTeamUser((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {} }));
    if (!('result' in teamRun)) throw new Error('expected preview');
    expect(teamRun.result.rows.length).toBe(2);
    expect((await asEngineer((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key)).toBe(false);
    await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { sharedRoleKeys: ['engineer'] }));
    const forEngineer = await asEngineer((ctx) => builder.listDefinitions(ctx));
    expect(forEngineer.items.some((d) => d.id === reportId && d.canEdit === false)).toBe(true);
    // someone the report is shared with who also builds may edit it, but retiring and restoring stay with the owner and report managers
    const sharedEditor = throwaway(['tenant:all', 'reports:run', 'reports:build', 'tickets:read'], 'engineer');
    expect((await runAs(sharedEditor, meta, (ctx) => builder.getDefinition(ctx, reportId))).canEdit).toBe(true);
    await expect(runAs(sharedEditor, meta, (ctx) => builder.updateDefinition(ctx, reportId, { isActive: false }))).rejects.toMatchObject({ statusCode: 403 });
    // the run card names who a shared report reaches
    const sharedDef = (await asBuilder((ctx) => reports.listDefinitions(ctx))).items.find((d) => d.key === key);
    expect(sharedDef?.custom?.sharedWith).toEqual(expect.arrayContaining([`Builder NOC ${S}`]));
    expect(sharedDef?.custom?.sharedWith?.length).toBe(2);
    await expect(asEngineer((ctx) => builder.updateDefinition(ctx, reportId, { name: 'hijack' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(asEngineer((ctx) => builder.deleteDefinition(ctx, reportId))).rejects.toMatchObject({ statusCode: 403 });
    const byManager = await asAdmin((ctx) => builder.updateDefinition(ctx, reportId, { description: 'Edited by a report manager' }));
    expect(byManager.description).toBe('Edited by a report manager');
    await expect(asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { sharedRoleKeys: ['customer_admin'] }))).rejects.toThrow(/Unknown staff role/);
  });

  it('needs the entity\'s read permission even when shared', async () => {
    const assetsReport = await asBuilder((ctx) => builder.createDefinition(ctx, { name: `Asset register ${S}`, description: null, category: 'custom', entity: 'assets', spec: spec({ columns: ['tag', 'name', 'customer', 'warranty_end'] }), defaultDateRange: 'last_30_days', scopeCustomerId: null, visibility: 'shared', sharedRoleKeys: ['engineer'], sharedTeamIds: [], portalVisible: false, cover: false, isActive: true }));
    definitionIds.push(assetsReport.id);
    const blind = throwaway(['tenant:all', 'reports:run']);
    const listed = await runAs(blind, meta, (ctx) => reports.listDefinitions(ctx));
    expect(listed.items.some((d) => d.key === assetsReport.key)).toBe(false);
    expect((await runAs(blind, meta, (ctx) => builder.listDefinitions(ctx))).items.some((d) => d.id === assetsReport.id)).toBe(false);
    await expect(runAs(blind, meta, (ctx) => reports.runReport(ctx, { reportKey: assetsReport.key, parameters: {} }))).rejects.toMatchObject({ statusCode: 403 });
    const sighted = throwaway(['tenant:all', 'reports:run', 'assets:read']);
    expect((await runAs(sighted, meta, (ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === assetsReport.key)).toBe(true);
  });

  it('groups with aggregates, tiles, a chart and a sort', async () => {
    const grouped = await asBuilder((ctx) => builder.createDefinition(ctx, { name: `Tickets by customer ${S}`, description: null, category: 'custom', entity: 'tickets', spec: spec({ groupBy: ['customer'], aggregates: [{ fn: 'count' }, { fn: 'avg', field: 'resolution_minutes', label: 'Avg resolution' }], filters: [{ field: 'customer', op: 'in', value: [ids.customerA, ids.customerB] }], dateField: 'created_at', sort: { key: 'count', order: 'desc' }, chart: { type: 'bar', y: ['count'] } }), defaultDateRange: 'last_7_days', scopeCustomerId: null, visibility: 'shared', sharedRoleKeys: [], sharedTeamIds: [ids.team], portalVisible: false, cover: false, isActive: true }));
    definitionIds.push(grouped.id);
    // the service manager holds soc:read, so the SOC incident counts for them: 4 for A, 3 for B
    const out = await asBuilder((ctx) => reports.runReport(ctx, { reportKey: grouped.key, parameters: {} }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.rows.length).toBe(2);
    expect(out.result.rows.map((r) => [r.customer, Number(r.count)])).toEqual([[customerNameA, 4], [customerNameB, 3]]);
    expect(out.result.columns.map((c) => c.key)).toEqual(['customer', 'count', 'avg_resolution_minutes']);
    expect(out.result.summary?.map((s) => s.label)).toEqual(['Rows', 'Count', 'Avg resolution']);
    expect(out.result.summary?.[1]!.value).toBe(7);
    expect(out.result.charts?.length).toBe(1);
    expect(out.result.charts?.[0]).toMatchObject({ type: 'bar', x: 'label', y: ['count'] });
    expect(out.result.charts?.[0]!.data.map((d) => d.label).sort()).toEqual([customerNameA, customerNameB]);
    // the NOC engineer the report is shared with holds no soc:read: the SOC incident is not counted for them
    const asTeam = await asTeamUser((ctx) => reports.runReport(ctx, { reportKey: grouped.key, parameters: {} }));
    if (!('result' in asTeam)) throw new Error('expected preview');
    expect(asTeam.result.rows.reduce((s, r) => s + Number(r.count), 0)).toBe(6);
    expect(asTeam.result.rows.map((r) => Number(r.count))).toEqual([3, 3]);
  });

  it('pins a report fixed to one customer, in runs and in schedules', async () => {
    const fixed = await asBuilder((ctx) => builder.createDefinition(ctx, { name: `Customer A tickets ${S}`, description: null, category: 'custom', entity: 'tickets', spec: spec({ columns: ['number', 'customer', 'created_at'], dateField: 'created_at' }), defaultDateRange: 'last_30_days', scopeCustomerId: ids.customerA, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: false, isActive: true }));
    definitionIds.push(fixed.id);
    expect(fixed.scopeCustomerName).toBe(customerNameA);
    const out = await asBuilder((ctx) => reports.runReport(ctx, { reportKey: fixed.key, parameters: { customerId: ids.customerB } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.rows.length).toBeGreaterThan(0);
    expect(out.result.rows.every((r) => r.customer === customerNameA)).toBe(true);
    expect(out.parameters.customerId).toBe(ids.customerA);
    expect(out.report.parameters.some((p) => p.key === 'customerId')).toBe(false);
    const base = { name: `Fixed schedule ${S}`, reportKey: fixed.key, recipients: [`rb-${S}@example.test`], recipientUserIds: [], frequency: 'weekly' as const, timezone: 'UTC', dateRange: 'last_7_days' as const, format: 'csv' as const, delivery: 'email' as const, isActive: true };
    await expect(asAdmin((ctx) => schedules.createSchedule(ctx, { ...base, customerId: ids.customerB, filters: {} }))).rejects.toThrow(/fixed to/);
    await expect(asAdmin((ctx) => schedules.createSchedule(ctx, { ...base, customerId: null, filters: { perCustomer: true } }))).rejects.toThrow(/fixed to/);
  });

  it('schedules end to end, refuses deletion while scheduled, then retires and keeps History', async () => {
    const s = await asAdmin((ctx) => schedules.createSchedule(ctx, { name: `P1 schedule ${S}`, reportKey: key, customerId: null, recipients: [`rb-${S}@example.test`], recipientUserIds: [], frequency: 'weekly', timezone: 'UTC', dateRange: 'last_30_days', filters: {}, format: 'csv', delivery: 'email', isActive: true }));
    scheduleIds.push(s.id);
    expect(s.reportName).toBe(`P1 tickets ${S}`);
    const out = await executeSchedule(s.id, { manual: true });
    expect(out).toMatchObject({ targets: 1, runs: 1, failures: [] });
    const runs = await withSystem((tx) => tx.select().from(schema.reportRuns).where(eq(schema.reportRuns.scheduleId, s.id)));
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ status: 'completed', reportKey: key });
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'report.delivered'), eq(schema.notificationOutbox.entityId, runs[0]!.id))));
    expect(mails.length).toBe(1);
    await expect(asBuilder((ctx) => builder.deleteDefinition(ctx, reportId))).rejects.toMatchObject({ statusCode: 409 });
    // retiring through a patch meets the same refusal
    await expect(asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { isActive: false }))).rejects.toMatchObject({ statusCode: 409 });
    // fixing the report to one customer must not strand a schedule that runs it for another
    const forB = await asAdmin((ctx) => schedules.createSchedule(ctx, { name: `P1 schedule B ${S}`, reportKey: key, customerId: ids.customerB, recipients: [`rb-${S}@example.test`], recipientUserIds: [], frequency: 'weekly', timezone: 'UTC', dateRange: 'last_30_days', filters: {}, format: 'csv', delivery: 'email', isActive: true }));
    scheduleIds.push(forB.id);
    await expect(asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { scopeCustomerId: ids.customerA }))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(`P1 schedule B ${S}`) });
    await asAdmin((ctx) => schedules.deleteSchedule(ctx, forB.id));
    scheduleIds.splice(scheduleIds.indexOf(forB.id), 1);
    await asAdmin((ctx) => schedules.deleteSchedule(ctx, s.id));
    scheduleIds.splice(scheduleIds.indexOf(s.id), 1);
    await asBuilder((ctx) => builder.deleteDefinition(ctx, reportId));
    const [row] = await withSystem((tx) => tx.select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, reportId)));
    expect(row!.isActive).toBe(false);
    expect((await withSystem((tx) => tx.select().from(schema.reportRuns).where(eq(schema.reportRuns.id, runs[0]!.id)))).length).toBe(1);
    const history = await asBuilder((ctx) => reports.listRuns(ctx, { reportKey: key }));
    expect(history.items.some((r) => r.id === runs[0]!.id)).toBe(true);
    expect((await asBuilder((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key)).toBe(false);
    await expect(asBuilder((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {} }))).rejects.toMatchObject({ statusCode: 404 });
    expect((await asBuilder((ctx) => builder.listDefinitions(ctx))).items.some((d) => d.id === reportId)).toBe(false);
    await expect(asTeamUser((ctx) => builder.listDefinitions(ctx, { includeInactive: true }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await asAdmin((ctx) => builder.listDefinitions(ctx, { includeInactive: true }))).items.some((d) => d.id === reportId && !d.isActive)).toBe(true);
    const restored = await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { isActive: true }));
    expect(restored.isActive).toBe(true);
    expect((await asBuilder((ctx) => reports.listDefinitions(ctx))).items.some((d) => d.key === key)).toBe(true);
  });

  it('caps rows by the setting and turns a cancelled statement into a clear error without breaking the transaction', async () => {
    // a saved row limit above a lowered cap is clamped at run time, never refused
    await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { spec: ticketSpec({ rowLimit: 5 }) }));
    await setSetting('reports.builder.max_rows', 1);
    const out = await asBuilder((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {} }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.rows.length).toBe(1);
    expect(out.result.truncated).toBe(true);
    expect(out.result.rowCount).toBe(2);
    await expect(asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { spec: ticketSpec({ rowLimit: 5 }) }))).rejects.toThrow(/Row limit must be between 1 and 1/);
    await setSetting('reports.builder.max_rows', 10000);
    await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { spec: ticketSpec() }));
    expect(builder.mapQueryError({ code: '57014' }, 5000)).toMatchObject({ statusCode: 422, message: expect.stringMatching(/longer than 5 seconds/) });
    expect(builder.mapQueryError({ cause: { code: '57014' } }, 20000)).toMatchObject({ statusCode: 422 });
    const other = new Error('boom');
    expect(builder.mapQueryError(other, 1000)).toBe(other);
    await asBuilder(async (ctx) => {
      await expect(builder.withStatementTimeout(ctx, 500, (tx) => tx.execute(sql`SELECT pg_sleep(2)`))).rejects.toThrow(/longer than/);
      const res = await ctx.tx.execute(sql`SELECT 1 AS one`);
      expect((res.rows[0] as { one: number }).one).toBe(1);
      const quick = await builder.withStatementTimeout(ctx, 2000, async (tx) => (await tx.execute(sql`SELECT 2 AS two`)).rows[0]);
      expect((quick as { two: number }).two).toBe(2);
    });
  });

  it('keeps the portal to published reports with portal-safe fields and the user\'s own organisation', async () => {
    expect((await asPortal((ctx) => builder.listDefinitions(ctx))).items).toEqual([]);
    await expect(asPortal((ctx) => builder.createDefinition(ctx, { name: 'x', description: null, category: 'custom', entity: 'tickets', spec: ticketSpec(), defaultDateRange: 'last_30_days', scopeCustomerId: null, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: false, isActive: true }))).rejects.toThrow(/not available in the customer portal/);
    await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { spec: ticketSpec({ columns: ['number', 'customer', 'priority', 'status', 'created_at', 'breach_risk'] }) }));
    await expect(asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { portalVisible: true }))).rejects.toThrow(/breach_risk/);
    const published = await asBuilder((ctx) => builder.updateDefinition(ctx, reportId, { spec: ticketSpec(), portalVisible: true }));
    expect(published.portalVisible).toBe(true);
    const listed = await asPortal((ctx) => builder.listDefinitions(ctx));
    expect(listed.items.map((d) => d.id)).toEqual([reportId]);
    expect(listed.items[0]).toMatchObject({ ownerName: null, visibility: null, canEdit: false, canDelete: false });
    expect(listed.items[0]).not.toHaveProperty('sharedRoleKeys');
    expect(listed.items[0]).not.toHaveProperty('sharedTeamIds');
    expect(listed.items[0]).not.toHaveProperty('ownerId');
    // the portal learns which fields a published report filters on, never the values (this spec names customer B's id)
    expect(JSON.stringify(listed)).not.toContain(ids.customerB);
    expect(listed.items[0]!.spec.filters.length).toBe(2);
    expect(listed.items[0]!.spec.filters.every((f) => !('value' in f))).toBe(true);
    expect(listed.items[0]!.summaryLines).toContain('Filter on Customer');
    const portalDef = (await asPortal((ctx) => reports.listDefinitions(ctx))).items.find((d) => d.key === key);
    expect(portalDef?.custom).toMatchObject({ ownerName: null, visibility: null, sharedWith: null });
    expect(JSON.stringify(portalDef)).not.toContain(ids.customerB);
    const out = await asPortal((ctx) => reports.runReport(ctx, { reportKey: key, parameters: { customerId: ids.customerB } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.parameters.customerId).toBe(ids.customerA);
    expect(out.result.rows.length).toBe(1);
    expect(out.result.rows.every((r) => r.customer === customerNameA)).toBe(true);
    const run = await asPortal((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {}, format: 'csv', portalVisible: true }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.portalVisible).toBe(true);
    expect(run.customerId).toBe(ids.customerA);
    const one = await asPortal((ctx) => builder.getDefinition(ctx, reportId));
    expect(one).toMatchObject({ ownerName: null, visibility: null });
    expect(one).not.toHaveProperty('sharedRoleKeys');
    await expect(asPortal((ctx) => builder.updateDefinition(ctx, reportId, { name: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(asPortal((ctx) => builder.deleteDefinition(ctx, reportId))).rejects.toMatchObject({ statusCode: 403 });
    await expect(asPortal((ctx) => builder.duplicateDefinition(ctx, reportId))).rejects.toMatchObject({ statusCode: 403 });
    // a report published for another organisation is hidden by the row policy itself
    const forB = await asBuilder((ctx) => builder.createDefinition(ctx, { name: `Customer B portal ${S}`, description: null, category: 'custom', entity: 'tickets', spec: spec({ columns: ['number', 'customer'] }), defaultDateRange: 'last_30_days', scopeCustomerId: ids.customerB, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: true, cover: false, isActive: true }));
    definitionIds.push(forB.id);
    expect((await asPortal((ctx) => builder.listDefinitions(ctx))).items.some((d) => d.id === forB.id)).toBe(false);
    await expect(asPortal((ctx) => builder.getDefinition(ctx, forB.id))).rejects.toMatchObject({ statusCode: 404 });
    await expect(asPortal((ctx) => reports.runReport(ctx, { reportKey: forB.key, parameters: {} }))).rejects.toMatchObject({ statusCode: 404 });
    expect((await asPortal((ctx) => ctx.tx.select({ id: schema.reportDefinitions.id }).from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, forB.id)))).length).toBe(0);
    // a later edit of a published report cannot slip an internal field in at run time
    await withSystem((tx) => tx.update(schema.reportDefinitions).set({ spec: ticketSpec({ columns: ['number', 'breach_risk'] }) }).where(eq(schema.reportDefinitions.id, reportId)));
    await expect(asPortal((ctx) => reports.runReport(ctx, { reportKey: key, parameters: {} }))).rejects.toThrow(/breach_risk/);
    await withSystem((tx) => tx.update(schema.reportDefinitions).set({ spec: ticketSpec() }).where(eq(schema.reportDefinitions.id, reportId)));
  });

  it('is fenced for the assistant: portal runs stay in the organisation, the builder tools are staff only and preview before they save', async () => {
    const runReport = toolByName('run_report')!;
    const res = await asPortal((ctx) => runReport.run(ctx, { report: key, customer: customerNameB }));
    const text = JSON.stringify(res);
    expect(text).not.toContain(customerNameB);
    expect(text).not.toContain(`RBB${S.toUpperCase()}`);
    expect(text).not.toContain(ids.customerB);
    expect((res as { rows: { customer: string }[] }).rows.every((r) => r.customer === customerNameA)).toBe(true);
    const portalTools = await asPortal(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(portalTools).not.toContain('report_catalog');
    expect(portalTools).not.toContain('build_report');
    const staffTools = await asBuilder(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(staffTools).toContain('report_catalog');
    expect(staffTools).toContain('build_report');
    const catalogTool = toolByName('report_catalog')!;
    const cat = (await asBuilder((ctx) => catalogTool.run(ctx, { entity: 'visits' }))) as { entities: { key: string; fields: { key: string }[] }[]; facts: string[] };
    expect(cat.entities.map((e) => e.key)).toEqual(['visits']);
    expect(cat.entities[0]!.fields.some((f) => f.key === 'engineer')).toBe(true);
    // the widest entity still fits in one tool result (MAX_TOOL_RESULT_CHARS) when asked for alone
    for (const entity of ['tickets', 'changes', 'cis', 'assets']) {
      const one = await asBuilder((ctx) => catalogTool.run(ctx, { entity }));
      expect(JSON.stringify(one).length, `${entity} catalogue size`).toBeLessThan(6000);
    }
    const all = (await asBuilder((ctx) => catalogTool.run(ctx, {}))) as { entities: { key: string; fieldCount: number }[] };
    expect(all.entities.length).toBe(12);
    expect(all.entities.every((e) => typeof e.fieldCount === 'number')).toBe(true);
    expect(JSON.stringify(all).length).toBeLessThan(6000);
    const build = toolByName('build_report')!;
    const input = { name: `Visit sample ${S}`, entity: 'visits', filters: [{ field: 'status', op: 'in', value: ['completed'] }], share: 'shared', shareWithRoles: ['management'], shareWithTeams: [`Builder NOC ${S}`] };
    const preview = (await asBuilder((ctx) => build.preview!(ctx, input))) as { text: string; lines: string[]; count: number };
    expect(preview.text).toContain(`Save custom report "Visit sample ${S}" on field visits`);
    expect(preview.text).toContain('shared with management, Builder NOC');
    expect(preview.lines.some((l) => l === 'Filter: Status is any of Completed')).toBe(true);
    // a misspelt role is refused when the proposal is made, not after the person confirms it
    await expect(asBuilder((ctx) => build.preview!(ctx, { ...input, shareWithRoles: ['managment'] }))).rejects.toThrow(/Unknown staff role/);
    expect(preview.lines.length).toBeGreaterThan(1);
    expect(typeof preview.count).toBe('number');
    const saved = (await asBuilder((ctx) => build.run(ctx, input))) as { id: string; key: string; link: string; runLink: string };
    definitionIds.push(saved.id);
    expect(saved.link).toBe(`/reports/builder/${saved.id}`);
    expect(saved.runLink).toBe(`/reports?tab=run&report=custom:${saved.id}`);
    const stored = await asBuilder((ctx) => builder.getDefinition(ctx, saved.id));
    expect(stored).toMatchObject({ visibility: 'shared', sharedRoleKeys: ['management'], sharedTeamIds: [ids.team], entity: 'visits' });
    await expect(asEngineer((ctx) => build.preview!(ctx, input))).rejects.toMatchObject({ statusCode: 403 });
    const listed = (await asBuilder((ctx) => toolByName('list_reports')!.run(ctx, {}))) as { items: { key: string; custom: boolean; builderLink?: string }[] };
    expect(listed.items.find((d) => d.key === saved.key)).toMatchObject({ custom: true, builderLink: `/reports/builder/${saved.id}` });
    expect(listed.items.find((d) => d.key === 'open_tickets')).toMatchObject({ custom: false });
  });

  it('suggests a definition from a sentence: the model\'s draft when usable, a deterministic draft otherwise, nothing for the engineer', async () => {
    let calls = 0;
    ai.setProviderForTests({ name: 'test', model: 'test', chat: async () => (calls++, json({ name: 'P1 incidents', entity: 'tickets', columns: ['number', 'title', 'customer'], filters: [{ field: 'priority_level', op: 'lte', value: 1 }, { field: 'type', op: 'in', value: ['incident'] }], match: 'all', groupBy: [], aggregates: [], sort: { key: 'created_at', order: 'desc' }, dateField: 'created_at', defaultDateRange: 'last_7_days', chart: null })) });
    const good = await asBuilder((ctx) => suggest(ctx, { prompt: 'P1 incidents in the last week' }));
    expect(good.ai).toBe(true);
    expect(good.definition).toMatchObject({ name: 'P1 incidents', entity: 'tickets', defaultDateRange: 'last_7_days' });
    expect(good.definition.spec?.columns).toEqual(['number', 'title', 'customer']);
    expect(() => validateSpec(ENTITIES.tickets, good.definition.spec, { portal: false, maxRows: 100 })).not.toThrow();
    ai.setProviderForTests({ name: 'test', model: 'test', chat: async () => (calls++, json({ entity: 'tickets', columns: ['nope; DROP TABLE tickets'] })) });
    const bad = await asBuilder((ctx) => suggest(ctx, { prompt: 'time by engineer last month' }));
    expect(bad.ai).toBe(false);
    expect(bad.definition).toMatchObject({ entity: 'time_entries', defaultDateRange: 'last_month' });
    expect(bad.definition.spec?.groupBy).toEqual(['user']);
    expect(bad.definition.spec?.aggregates).toEqual([{ fn: 'count', label: 'Count' }]);
    expect(bad.notes.join(' ')).toMatch(/not usable/);
    ai.setProviderForTests({ name: 'test', model: 'test', chat: async () => (calls++, json({ entity: 'tickets', columns: ['nope'] })) });
    const silent = await asBuilder((ctx) => suggest(ctx, { prompt: 'open changes by customer' }));
    expect(silent.definition).toMatchObject({ entity: 'changes' });
    expect(silent.definition.spec?.groupBy).toEqual(['customer']);
    await setSetting('ai.disabled_features', ['report_builder']);
    const before = calls;
    const off = await asBuilder((ctx) => suggest(ctx, { prompt: 'warranty register', entity: 'assets' }));
    expect(off.ai).toBe(false);
    expect(calls).toBe(before);
    expect(off.definition).toMatchObject({ entity: 'assets' });
    expect(off.definition.spec?.columns).toEqual(ENTITIES.assets.defaultColumns);
    await setSetting('ai.disabled_features', []);
    await expect(asEngineer((ctx) => suggest(ctx, { prompt: 'anything' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(asPortal((ctx) => suggest(ctx, { prompt: 'anything' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(fallbackSpec('surveys by channel this quarter').spec?.groupBy).toEqual(['channel']);
    expect(fallbackSpec('surveys by channel this quarter').defaultDateRange).toBe('quarter_to_date');
    ai.setProviderForTests(null);
  });

  it('hides SOC tickets and their time from staff without soc:read in every ticket-derived entity', async () => {
    const socNumber = tickets.find((t) => t.id === ids.socTicket)!.number;
    const asNoSoc = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(noSoc(), meta, fn);
    const list = spec({ columns: ['number'], filters: [{ field: 'customer', op: 'in', value: [ids.customerA] }] });
    const forBuilder = await asNoSoc((ctx) => builder.preview(ctx, { entity: 'tickets', spec: list, parameters: {}, portal: false }));
    expect(forBuilder.rows.map((r) => r.number)).not.toContain(socNumber);
    const forAdmin = await asAdmin((ctx) => builder.preview(ctx, { entity: 'tickets', spec: list, parameters: {}, portal: false }));
    expect(forAdmin.rows.map((r) => r.number)).toContain(socNumber);
    const time = spec({ columns: ['ticket_number', 'minutes'], filters: [{ field: 'customer', op: 'in', value: [ids.customerA] }] });
    const timeBuilder = await asNoSoc((ctx) => builder.preview(ctx, { entity: 'time_entries', spec: time, parameters: {}, portal: false }));
    expect(timeBuilder.rows.map((r) => r.ticket_number)).toEqual(expect.not.arrayContaining([socNumber]));
    expect(timeBuilder.rowCount).toBe(1);
    const timeAdmin = await asAdmin((ctx) => builder.preview(ctx, { entity: 'time_entries', spec: time, parameters: {}, portal: false }));
    expect(timeAdmin.rows.map((r) => r.ticket_number)).toContain(socNumber);
    expect(timeAdmin.rowCount).toBe(2);
    const clocks = await asNoSoc((ctx) => builder.preview(ctx, { entity: 'sla_clocks', spec: spec({ columns: ['ticket_number', 'metric', 'state'], filters: [{ field: 'customer', op: 'in', value: [ids.customerA] }] }), parameters: {}, portal: false }));
    expect(clocks.rows.map((r) => r.ticket_number)).not.toContain(socNumber);
    expect(clocks.rowCount).toBeGreaterThan(0);
  });

  it('runs every entity and the entitlement totals through the compiler against the database', async () => {
    for (const key of ENTITY_KEYS) {
      const e = ENTITIES[key];
      const out = await asAdmin((ctx) => builder.preview(ctx, { entity: key, spec: spec({ columns: e.defaultColumns, dateField: null }), parameters: {}, portal: false }));
      expect(out.columns.map((c) => c.key), key).toEqual(e.defaultColumns);
      expect(Array.isArray(out.rows), key).toBe(true);
    }
    const ent = await asAdmin((ctx) => builder.preview(ctx, { entity: 'entitlements', spec: spec({ columns: ['name', 'customer', 'quantity', 'consumed_total', 'consumed_pct', 'remaining'], filters: [{ field: 'customer', op: 'in', value: [ids.customerA] }] }), parameters: {}, portal: false }));
    expect(ent.rows.length).toBe(1);
    expect(ent.rows[0]).toMatchObject({ quantity: 10, consumed_total: 6.5, consumed_pct: 65, remaining: 3.5 });
    const assets = await asAdmin((ctx) => builder.preview(ctx, { entity: 'assets', spec: spec({ groupBy: ['customer'], aggregates: [{ fn: 'count' }, { fn: 'min', field: 'warranty_days_left' }], filters: [{ field: 'customer', op: 'in', value: [ids.customerA, ids.customerB] }, { field: 'tags', op: 'is_empty' }], sort: { key: 'min_warranty_days_left', order: 'asc' } }), parameters: {}, portal: false }));
    expect(assets.rows.length).toBe(2);
    expect(assets.rows[0]!.customer).toBe(customerNameA);
  });

  it('lists the catalogue with share targets and marks entities the caller may not read', async () => {
    const cat = await asBuilder((ctx) => builder.catalog(ctx));
    expect(cat.entities.length).toBe(12);
    expect(cat.entities.every((e) => e.permissionsOk)).toBe(true);
    expect(cat.entities.every((e) => e.fields.every((f) => !('select' in f)))).toBe(true);
    expect(cat.shareTargets.roles.map((r) => r.key)).toContain('management');
    expect(cat.shareTargets.roles.map((r) => r.key)).not.toContain('admin');
    expect(cat.shareTargets.roles.map((r) => r.key)).not.toContain('customer_admin');
    expect(cat.shareTargets.teams.some((t) => t.id === ids.team)).toBe(true);
    expect(cat.presets).not.toContain('custom');
    expect(cat.limits.previewRows).toBe(500);
    const blind = throwaway(['tenant:all', 'reports:run', 'reports:build']);
    const partial = await runAs(blind, meta, (ctx) => builder.catalog(ctx));
    expect(partial.entities.find((e) => e.key === 'assets')?.permissionsOk).toBe(false);
    expect(partial.entities.find((e) => e.key === 'tickets')?.permissionsOk).toBe(true);
    await expect(asEngineer((ctx) => builder.catalog(ctx))).rejects.toMatchObject({ statusCode: 403 });
    await expect(asPortal((ctx) => builder.catalog(ctx))).rejects.toMatchObject({ statusCode: 403 });
    // a report manager without reports:build opens the editor on anyone's report: the catalogue and the preview answer, saving a new report does not
    const manager = throwaway(['tenant:all', 'reports:run', 'reports:manage']);
    expect((await runAs(manager, meta, (ctx) => builder.catalog(ctx))).entities.length).toBe(12);
    expect((await runAs(manager, meta, (ctx) => builder.preview(ctx, { entity: 'tickets', spec: spec({ columns: ['number'] }), parameters: {}, portal: false }))).columns.map((c) => c.key)).toEqual(['number']);
    await expect(runAs(manager, meta, (ctx) => builder.createDefinition(ctx, { name: 'x', description: null, category: 'custom', entity: 'tickets', spec: spec({ columns: ['number'] }), defaultDateRange: 'last_30_days', scopeCustomerId: null, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: false, isActive: true }))).rejects.toMatchObject({ statusCode: 403 });
    const copy = await asBuilder((ctx) => builder.duplicateDefinition(ctx, reportId));
    definitionIds.push(copy.id);
    expect(copy.name).toBe(`P1 tickets ${S} (copy)`);
    expect(copy).toMatchObject({ visibility: 'private', portalVisible: false, ownerName: `builder ${S}` });
  });
});
