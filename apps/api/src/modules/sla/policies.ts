import { eq, and, asc, sql, inArray, gte, lte, desc } from 'drizzle-orm';
import { SLA_METRICS, TICKET_TYPES, type SlaMetric, type TicketType } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ValidationError, ConflictError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { addWorkingMinutes, CALENDAR_24X7, type CalendarDef } from '@/lib/calendar';

/**
 * SLA policy administration: policies, targets (ticket type x priority x metric),
 * pause statuses, preview and compliance reporting. The runtime engine that
 * attaches SLAs to tickets lives in ./engine.ts and policy selection in ./select.ts.
 */

export interface TargetInput {
  ticketType: TicketType;
  priorityId: string | null;
  metric: SlaMetric;
  minutes: number;
  warnPct?: number;
  calendarTime?: boolean;
}

export interface PolicyInput {
  name: string;
  description?: string | null;
  calendarId?: string | null;
  holidayCalendarId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  targets?: TargetInput[];
}

export interface PolicyUsage {
  contracts: number;
  contractServices: number;
  catalogItems: number;
  services: number;
  tickets: number;
}

// ---------------------------------------------------------------- validation

export function validateTargets(targets: TargetInput[]) {
  const seen = new Set<string>();
  for (const t of targets) {
    if (!(TICKET_TYPES as readonly string[]).includes(t.ticketType)) throw new ValidationError(`Unknown ticket type: ${t.ticketType}`);
    if (!(SLA_METRICS as readonly string[]).includes(t.metric)) throw new ValidationError(`Unknown SLA metric: ${t.metric}`);
    if (!Number.isInteger(t.minutes) || t.minutes <= 0) throw new ValidationError(`Target for ${t.ticketType}/${t.metric} must be a positive number of minutes`);
    if (t.warnPct !== undefined && (t.warnPct < 1 || t.warnPct > 100)) throw new ValidationError('Warning threshold must be between 1 and 100 percent');
    const key = `${t.ticketType}|${t.priorityId ?? 'any'}|${t.metric}`;
    if (seen.has(key)) throw new ValidationError(`Duplicate target for ${t.ticketType} / ${t.priorityId ? 'priority ' + t.priorityId : 'any priority'} / ${t.metric}`);
    seen.add(key);
  }
}

async function assertPriorityIds(ctx: Ctx, targets: TargetInput[]) {
  const ids = [...new Set(targets.map((t) => t.priorityId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await ctx.tx.select({ id: schema.configOptions.id, type: schema.configOptions.type }).from(schema.configOptions).where(inArray(schema.configOptions.id, ids));
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.type !== 'ticket_priority') throw new ValidationError('Targets must reference ticket priorities');
  }
}

// ---------------------------------------------------------------- read

async function loadExtras(ctx: Ctx, policyIds: string[]) {
  if (!policyIds.length) return { targets: [], pauses: [], usage: new Map<string, PolicyUsage>() };
  const [targets, pauses, contracts, contractServices, catalogItems, services, tickets] = await Promise.all([
    ctx.tx
      .select({
        id: schema.slaTargets.id,
        policyId: schema.slaTargets.policyId,
        ticketType: schema.slaTargets.ticketType,
        priorityId: schema.slaTargets.priorityId,
        priorityLabel: schema.configOptions.label,
        priorityLevel: schema.configOptions.level,
        metric: schema.slaTargets.metric,
        minutes: schema.slaTargets.minutes,
        warnPct: schema.slaTargets.warnPct,
        calendarTime: schema.slaTargets.calendarTime,
      })
      .from(schema.slaTargets)
      .leftJoin(schema.configOptions, eq(schema.configOptions.id, schema.slaTargets.priorityId))
      .where(inArray(schema.slaTargets.policyId, policyIds))
      .orderBy(asc(schema.slaTargets.ticketType), asc(schema.configOptions.level), asc(schema.slaTargets.metric)),
    ctx.tx
      .select({ policyId: schema.slaPauseStatuses.policyId, statusId: schema.slaPauseStatuses.statusId, label: schema.configOptions.label })
      .from(schema.slaPauseStatuses)
      .innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.slaPauseStatuses.statusId))
      .where(inArray(schema.slaPauseStatuses.policyId, policyIds)),
    ctx.tx.select({ policyId: schema.contracts.slaPolicyId, count: sql<number>`count(*)::int` }).from(schema.contracts).where(inArray(schema.contracts.slaPolicyId, policyIds)).groupBy(schema.contracts.slaPolicyId),
    ctx.tx.select({ policyId: schema.contractServices.slaPolicyId, count: sql<number>`count(*)::int` }).from(schema.contractServices).where(inArray(schema.contractServices.slaPolicyId, policyIds)).groupBy(schema.contractServices.slaPolicyId),
    ctx.tx.select({ policyId: schema.catalogItems.slaPolicyId, count: sql<number>`count(*)::int` }).from(schema.catalogItems).where(inArray(schema.catalogItems.slaPolicyId, policyIds)).groupBy(schema.catalogItems.slaPolicyId),
    ctx.tx.select({ policyId: schema.services.defaultSlaPolicyId, count: sql<number>`count(*)::int` }).from(schema.services).where(inArray(schema.services.defaultSlaPolicyId, policyIds)).groupBy(schema.services.defaultSlaPolicyId),
    ctx.tx.select({ policyId: schema.tickets.slaPolicyId, count: sql<number>`count(*)::int` }).from(schema.tickets).where(inArray(schema.tickets.slaPolicyId, policyIds)).groupBy(schema.tickets.slaPolicyId),
  ]);
  const usage = new Map<string, PolicyUsage>();
  for (const id of policyIds) {
    usage.set(id, {
      contracts: contracts.find((c) => c.policyId === id)?.count ?? 0,
      contractServices: contractServices.find((c) => c.policyId === id)?.count ?? 0,
      catalogItems: catalogItems.find((c) => c.policyId === id)?.count ?? 0,
      services: services.find((c) => c.policyId === id)?.count ?? 0,
      tickets: tickets.find((c) => c.policyId === id)?.count ?? 0,
    });
  }
  return { targets, pauses, usage };
}

function policySelect() {
  return {
    id: schema.slaPolicies.id,
    name: schema.slaPolicies.name,
    description: schema.slaPolicies.description,
    calendarId: schema.slaPolicies.calendarId,
    calendarName: schema.businessCalendars.name,
    calendarIs24x7: schema.businessCalendars.is24x7,
    calendarTimezone: schema.businessCalendars.timezone,
    holidayCalendarId: schema.slaPolicies.holidayCalendarId,
    holidayCalendarName: schema.holidayCalendars.name,
    isDefault: schema.slaPolicies.isDefault,
    isActive: schema.slaPolicies.isActive,
    createdAt: schema.slaPolicies.createdAt,
    updatedAt: schema.slaPolicies.updatedAt,
  };
}

function decorate<T extends { id: string }>(row: T, extras: Awaited<ReturnType<typeof loadExtras>>) {
  return {
    ...row,
    targets: extras.targets.filter((t) => t.policyId === row.id).map(({ policyId: _p, ...t }) => t),
    pauseStatusIds: extras.pauses.filter((p) => p.policyId === row.id).map((p) => p.statusId),
    pauseStatuses: extras.pauses.filter((p) => p.policyId === row.id).map((p) => ({ id: p.statusId, label: p.label })),
    usage: extras.usage.get(row.id) ?? { contracts: 0, contractServices: 0, catalogItems: 0, services: 0, tickets: 0 },
  };
}

export async function listPolicies(ctx: Ctx) {
  const rows = await ctx.tx
    .select(policySelect())
    .from(schema.slaPolicies)
    .leftJoin(schema.businessCalendars, eq(schema.businessCalendars.id, schema.slaPolicies.calendarId))
    .leftJoin(schema.holidayCalendars, eq(schema.holidayCalendars.id, schema.slaPolicies.holidayCalendarId))
    .orderBy(desc(schema.slaPolicies.isDefault), asc(schema.slaPolicies.name));
  const extras = await loadExtras(ctx, rows.map((r) => r.id));
  return { items: rows.map((r) => decorate(r, extras)) };
}

export async function getPolicy(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select(policySelect())
    .from(schema.slaPolicies)
    .leftJoin(schema.businessCalendars, eq(schema.businessCalendars.id, schema.slaPolicies.calendarId))
    .leftJoin(schema.holidayCalendars, eq(schema.holidayCalendars.id, schema.slaPolicies.holidayCalendarId))
    .where(eq(schema.slaPolicies.id, id))
    .limit(1);
  if (!row) throw new NotFoundError('SLA policy');
  const extras = await loadExtras(ctx, [id]);
  return decorate(row, extras);
}

// ---------------------------------------------------------------- write

async function assertCalendars(ctx: Ctx, calendarId?: string | null, holidayCalendarId?: string | null) {
  if (calendarId) {
    const [c] = await ctx.tx.select({ id: schema.businessCalendars.id }).from(schema.businessCalendars).where(eq(schema.businessCalendars.id, calendarId)).limit(1);
    if (!c) throw new ValidationError('Business calendar not found');
  }
  if (holidayCalendarId) {
    const [c] = await ctx.tx.select({ id: schema.holidayCalendars.id }).from(schema.holidayCalendars).where(eq(schema.holidayCalendars.id, holidayCalendarId)).limit(1);
    if (!c) throw new ValidationError('Holiday calendar not found');
  }
}

async function insertTargets(ctx: Ctx, policyId: string, targets: TargetInput[]) {
  if (!targets.length) return;
  await ctx.tx.insert(schema.slaTargets).values(
    targets.map((t) => ({ policyId, ticketType: t.ticketType, priorityId: t.priorityId ?? null, metric: t.metric, minutes: t.minutes, warnPct: t.warnPct ?? 75, calendarTime: t.calendarTime ?? false })),
  );
}

export async function createPolicy(ctx: Ctx, input: PolicyInput) {
  const targets = input.targets ?? [];
  validateTargets(targets);
  await assertPriorityIds(ctx, targets);
  await assertCalendars(ctx, input.calendarId, input.holidayCalendarId);
  if (input.isDefault) await ctx.tx.update(schema.slaPolicies).set({ isDefault: false, updatedAt: new Date() }).where(eq(schema.slaPolicies.isDefault, true));
  const [row] = await ctx.tx
    .insert(schema.slaPolicies)
    .values({ name: input.name, description: input.description ?? null, calendarId: input.calendarId ?? null, holidayCalendarId: input.holidayCalendarId ?? null, isDefault: input.isDefault ?? false, isActive: input.isActive ?? true })
    .returning();
  await insertTargets(ctx, row.id, targets);
  await ctx.audit({ entityType: 'sla_policy', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { targets: targets.length, isDefault: row.isDefault } });
  return getPolicy(ctx, row.id);
}

export async function updatePolicy(ctx: Ctx, id: string, patch: Partial<Omit<PolicyInput, 'targets'>>) {
  const [before] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, id)).limit(1);
  if (!before) throw new NotFoundError('SLA policy');
  await assertCalendars(ctx, patch.calendarId, patch.holidayCalendarId);
  if (patch.isDefault === false && before.isDefault) throw new ValidationError('Make another policy the default instead of unsetting this one');
  if (patch.isActive === false && before.isDefault) throw new ValidationError('The default policy cannot be deactivated');
  if (patch.isDefault && !before.isDefault) await ctx.tx.update(schema.slaPolicies).set({ isDefault: false, updatedAt: new Date() }).where(eq(schema.slaPolicies.isDefault, true));
  const values: Partial<typeof schema.slaPolicies.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.calendarId !== undefined) values.calendarId = patch.calendarId;
  if (patch.holidayCalendarId !== undefined) values.holidayCalendarId = patch.holidayCalendarId;
  if (patch.isDefault !== undefined) values.isDefault = patch.isDefault;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  const [after] = await ctx.tx.update(schema.slaPolicies).set(values).where(eq(schema.slaPolicies.id, id)).returning();
  await ctx.audit({ entityType: 'sla_policy', entityId: id, entityLabel: after.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>) });
  return getPolicy(ctx, id);
}

export async function replaceTargets(ctx: Ctx, id: string, targets: TargetInput[]) {
  const [policy] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, id)).limit(1);
  if (!policy) throw new NotFoundError('SLA policy');
  validateTargets(targets);
  await assertPriorityIds(ctx, targets);
  const before = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.slaTargets).where(eq(schema.slaTargets.policyId, id));
  await ctx.tx.delete(schema.slaTargets).where(eq(schema.slaTargets.policyId, id));
  await insertTargets(ctx, id, targets);
  await ctx.tx.update(schema.slaPolicies).set({ updatedAt: new Date() }).where(eq(schema.slaPolicies.id, id));
  await ctx.audit({ entityType: 'sla_policy', entityId: id, entityLabel: policy.name, action: 'targets.update', changes: { targets: { old: before[0]?.count ?? 0, new: targets.length } } });
  return getPolicy(ctx, id);
}

export async function setPauseStatuses(ctx: Ctx, id: string, statusIds: string[]) {
  const [policy] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, id)).limit(1);
  if (!policy) throw new NotFoundError('SLA policy');
  const ids = [...new Set(statusIds)];
  if (ids.length) {
    const rows = await ctx.tx.select({ id: schema.configOptions.id, type: schema.configOptions.type }).from(schema.configOptions).where(inArray(schema.configOptions.id, ids));
    if (rows.length !== ids.length || rows.some((r) => r.type !== 'ticket_status')) throw new ValidationError('Pause statuses must be ticket statuses');
  }
  const before = await ctx.tx.select({ statusId: schema.slaPauseStatuses.statusId }).from(schema.slaPauseStatuses).where(eq(schema.slaPauseStatuses.policyId, id));
  await ctx.tx.delete(schema.slaPauseStatuses).where(eq(schema.slaPauseStatuses.policyId, id));
  if (ids.length) await ctx.tx.insert(schema.slaPauseStatuses).values(ids.map((statusId) => ({ policyId: id, statusId })));
  await ctx.audit({ entityType: 'sla_policy', entityId: id, entityLabel: policy.name, action: 'pause_statuses.update', changes: { pauseStatuses: { old: before.map((b) => b.statusId), new: ids } } });
  return getPolicy(ctx, id);
}

export async function deletePolicy(ctx: Ctx, id: string) {
  const [policy] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, id)).limit(1);
  if (!policy) throw new NotFoundError('SLA policy');
  if (policy.isDefault) throw new ValidationError('The default SLA policy cannot be deleted. Make another policy the default first.');
  const { usage } = await loadExtras(ctx, [id]);
  const u = usage.get(id)!;
  const refs: string[] = [];
  if (u.contracts) refs.push(`${u.contracts} contract(s)`);
  if (u.contractServices) refs.push(`${u.contractServices} contract service(s)`);
  if (u.catalogItems) refs.push(`${u.catalogItems} catalog item(s)`);
  if (u.services) refs.push(`${u.services} service(s)`);
  if (u.tickets) refs.push(`${u.tickets} ticket(s)`);
  if (refs.length) throw new ConflictError(`This policy is referenced by ${refs.join(', ')}. Deactivate it instead.`);
  await ctx.tx.delete(schema.slaPolicies).where(eq(schema.slaPolicies.id, id));
  await ctx.audit({ entityType: 'sla_policy', entityId: id, entityLabel: policy.name, action: 'delete' });
  return { deleted: true };
}

export async function clonePolicy(ctx: Ctx, id: string, name?: string) {
  const [policy] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, id)).limit(1);
  if (!policy) throw new NotFoundError('SLA policy');
  const targets = await ctx.tx.select().from(schema.slaTargets).where(eq(schema.slaTargets.policyId, id));
  const pauses = await ctx.tx.select().from(schema.slaPauseStatuses).where(eq(schema.slaPauseStatuses.policyId, id));
  const [row] = await ctx.tx
    .insert(schema.slaPolicies)
    .values({ name: name?.trim() || `Copy of ${policy.name}`, description: policy.description, calendarId: policy.calendarId, holidayCalendarId: policy.holidayCalendarId, isDefault: false, isActive: true })
    .returning();
  await insertTargets(ctx, row.id, targets.map((t) => ({ ticketType: t.ticketType, priorityId: t.priorityId, metric: t.metric, minutes: t.minutes, warnPct: t.warnPct, calendarTime: t.calendarTime })));
  if (pauses.length) await ctx.tx.insert(schema.slaPauseStatuses).values(pauses.map((p) => ({ policyId: row.id, statusId: p.statusId })));
  await ctx.audit({ entityType: 'sla_policy', entityId: row.id, entityLabel: row.name, action: 'clone', metadata: { sourceId: id } });
  return getPolicy(ctx, row.id);
}

// ---------------------------------------------------------------- preview

/** Resolves the calendar definition a policy uses (holidays included). Exported for the engine. */
export async function policyCalendar(ctx: Ctx, policy: { calendarId: string | null; holidayCalendarId: string | null }): Promise<{ def: CalendarDef; name: string; id: string | null }> {
  let cal: typeof schema.businessCalendars.$inferSelect | undefined;
  if (policy.calendarId) [cal] = await ctx.tx.select().from(schema.businessCalendars).where(eq(schema.businessCalendars.id, policy.calendarId)).limit(1);
  if (!cal) [cal] = await ctx.tx.select().from(schema.businessCalendars).where(eq(schema.businessCalendars.isDefault, true)).limit(1);
  if (!cal) return { def: CALENDAR_24X7, name: '24x7', id: null };
  const holidayCalendarId = policy.holidayCalendarId ?? cal.holidayCalendarId;
  const holidays = holidayCalendarId ? (await ctx.tx.select({ date: schema.holidays.date }).from(schema.holidays).where(eq(schema.holidays.calendarId, holidayCalendarId))).map((h) => h.date) : [];
  return { def: { timezone: cal.timezone, is24x7: cal.is24x7, hours: cal.hours, holidays }, name: cal.name, id: cal.id };
}

/** Picks the targets that apply to a ticket type/priority: priority-specific first, then "any priority". */
export function resolveTargets<T extends { ticketType: string; priorityId: string | null; metric: string }>(targets: T[], ticketType: string, priorityId: string | null) {
  const out: T[] = [];
  for (const metric of SLA_METRICS) {
    const specific = priorityId ? targets.find((t) => t.ticketType === ticketType && t.priorityId === priorityId && t.metric === metric) : undefined;
    const any = targets.find((t) => t.ticketType === ticketType && t.priorityId === null && t.metric === metric);
    const hit = specific ?? any;
    if (hit) out.push(hit);
  }
  return out;
}

export async function preview(ctx: Ctx, params: { policyId: string; ticketType: TicketType; priorityId?: string | null; start?: string }) {
  const [policy] = await ctx.tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, params.policyId)).limit(1);
  if (!policy) throw new NotFoundError('SLA policy');
  const start = params.start ? new Date(params.start) : new Date();
  if (isNaN(start.getTime())) throw new ValidationError('Invalid start date');
  const targets = await ctx.tx.select().from(schema.slaTargets).where(eq(schema.slaTargets.policyId, policy.id));
  const applicable = resolveTargets(targets, params.ticketType, params.priorityId ?? null);
  const cal = await policyCalendar(ctx, policy);
  const metrics = applicable.map((t) => {
    const def = t.calendarTime ? CALENDAR_24X7 : cal.def;
    const dueAt = addWorkingMinutes(start, t.minutes, def);
    const warnAt = addWorkingMinutes(start, Math.round((t.minutes * t.warnPct) / 100), def);
    return {
      metric: t.metric,
      minutes: t.minutes,
      warnPct: t.warnPct,
      calendarTime: t.calendarTime,
      calendar: t.calendarTime || def.is24x7 ? '24x7' : cal.name,
      timezone: def.timezone,
      appliesTo: t.priorityId ? 'priority' : 'any',
      dueAt: dueAt.toISOString(),
      warnAt: warnAt.toISOString(),
      elapsedHours: Math.round(((dueAt.getTime() - start.getTime()) / 3_600_000) * 10) / 10,
    };
  });
  return {
    policy: { id: policy.id, name: policy.name },
    calendar: { id: cal.id, name: cal.name, timezone: cal.def.timezone, is24x7: cal.def.is24x7, holidays: cal.def.holidays.length },
    ticketType: params.ticketType,
    priorityId: params.priorityId ?? null,
    start: start.toISOString(),
    metrics,
  };
}

// ---------------------------------------------------------------- compliance

export type ComplianceGroupBy = 'metric' | 'priority' | 'customer' | 'service' | 'policy' | 'ticketType';

export interface ComplianceParams {
  customerId?: string;
  from?: string;
  to?: string;
  groupBy?: ComplianceGroupBy;
  ticketType?: TicketType;
  metric?: SlaMetric;
}

/**
 * Compliance figures from ticket_slas. Shared by the admin screens and the
 * dashboards module. Tenant RLS limits visible rows automatically; an explicit
 * customer filter narrows further.
 */
export async function slaCompliance(ctx: Ctx, params: ComplianceParams = {}) {
  if (params.customerId) ctx.requireCustomer(params.customerId);
  const groupBy = params.groupBy ?? 'metric';
  const conds = [];
  if (params.customerId) conds.push(eq(schema.ticketSlas.customerId, params.customerId));
  if (params.from) {
    const d = new Date(params.from);
    if (isNaN(d.getTime())) throw new ValidationError('Invalid from date');
    conds.push(gte(schema.ticketSlas.startedAt, d));
  }
  if (params.to) {
    const d = new Date(params.to);
    if (isNaN(d.getTime())) throw new ValidationError('Invalid to date');
    conds.push(lte(schema.ticketSlas.startedAt, d));
  }
  if (params.ticketType) conds.push(eq(schema.tickets.type, params.ticketType));
  if (params.metric) conds.push(eq(schema.ticketSlas.metric, params.metric));

  const groupKey = {
    metric: sql<string>`${schema.ticketSlas.metric}::text`,
    priority: sql<string>`coalesce(${schema.tickets.priorityId}::text, '')`,
    customer: sql<string>`${schema.ticketSlas.customerId}::text`,
    service: sql<string>`coalesce(${schema.tickets.serviceId}::text, '')`,
    policy: sql<string>`coalesce(${schema.ticketSlas.policyId}::text, '')`,
    ticketType: sql<string>`${schema.tickets.type}::text`,
  }[groupBy];
  const groupLabel = {
    metric: sql<string>`${schema.ticketSlas.metric}::text`,
    priority: sql<string>`coalesce(${schema.configOptions.label}, 'No priority')`,
    customer: sql<string>`coalesce(${schema.customers.name}, '')`,
    service: sql<string>`coalesce(${schema.services.name}, 'No service')`,
    policy: sql<string>`coalesce(${schema.slaPolicies.name}, 'No policy')`,
    ticketType: sql<string>`${schema.tickets.type}::text`,
  }[groupBy];

  const rows = await ctx.tx
    .select({
      key: groupKey,
      label: groupLabel,
      met: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'met')::int`,
      breached: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'breached')::int`,
      running: sql<number>`count(*) filter (where ${schema.ticketSlas.state} in ('running', 'paused'))::int`,
      paused: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'paused')::int`,
      cancelled: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'cancelled')::int`,
      overdueRunning: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'running' and ${schema.ticketSlas.dueAt} < now())::int`,
      avgElapsedMinutes: sql<number | null>`round(avg(${schema.ticketSlas.elapsedMinutesAtCompletion}) filter (where ${schema.ticketSlas.state} in ('met', 'breached')))::int`,
      avgTargetMinutes: sql<number | null>`round(avg(${schema.ticketSlas.targetMinutes}))::int`,
    })
    .from(schema.ticketSlas)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketSlas.ticketId))
    .leftJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.priorityId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.ticketSlas.customerId))
    .leftJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId))
    .leftJoin(schema.slaPolicies, eq(schema.slaPolicies.id, schema.ticketSlas.policyId))
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(groupKey, groupLabel)
    .orderBy(groupLabel);

  const pct = (met: number, breached: number) => (met + breached > 0 ? Math.round((met / (met + breached)) * 1000) / 10 : null);
  const groups = rows.map((r) => ({ ...r, completed: r.met + r.breached, compliancePct: pct(r.met, r.breached) }));
  const totals = groups.reduce(
    (acc, g) => ({ met: acc.met + g.met, breached: acc.breached + g.breached, running: acc.running + g.running, paused: acc.paused + g.paused, cancelled: acc.cancelled + g.cancelled, overdueRunning: acc.overdueRunning + g.overdueRunning }),
    { met: 0, breached: 0, running: 0, paused: 0, cancelled: 0, overdueRunning: 0 },
  );
  const weighted = groups.filter((g) => g.avgElapsedMinutes !== null);
  const avgElapsedMinutes = weighted.length ? Math.round(weighted.reduce((s, g) => s + (g.avgElapsedMinutes ?? 0) * g.completed, 0) / Math.max(1, weighted.reduce((s, g) => s + g.completed, 0))) : null;
  return {
    groupBy,
    from: params.from ?? null,
    to: params.to ?? null,
    customerId: params.customerId ?? null,
    totals: { ...totals, completed: totals.met + totals.breached, compliancePct: pct(totals.met, totals.breached), avgElapsedMinutes },
    groups,
  };
}

/** Policies that are referenced nowhere and inactive can be listed for housekeeping. */
export async function unusedPolicies(ctx: Ctx) {
  const { items } = await listPolicies(ctx);
  return items.filter((p) => !p.isDefault && p.usage.contracts + p.usage.contractServices + p.usage.catalogItems + p.usage.services === 0);
}

