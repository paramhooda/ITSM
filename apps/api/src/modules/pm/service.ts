import { eq, and, inArray, gte, lte, desc, asc, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { countRows, searchLike } from '@/core/query';
import { selectContractForTicket } from '@/modules/contracts/scope';
import { consumeEntitlement, entitlementUtilization } from '@/modules/contracts/entitlements';
import { addDays, addMonths, daysBetween } from '@/modules/contracts/common';
import { createTicket } from '@/modules/tickets/service';
import { addActivity } from '@/modules/tickets/common';
import { createVisit, scheduleVisit, rescheduleVisit, cancelVisit } from '@/modules/field/service';
import {
  type ProgramRow,
  type OccurrenceRow,
  isCustomerUser,
  userIdOf,
  csv,
  todayStr,
  requireRead,
  loadProgram,
  loadOccurrence,
  optionByKey,
  optionLabels,
  userNames,
  autoPickVisitEntitlement,
  notifyFieldEvent,
  pmLink,
  zonedDateTime,
  sequential,
  countSql,
} from '@/modules/field/common';
import type { ProgramListQuery, CreateProgramInput, UpdateProgramInput, OccurrenceListQuery, ScheduleOccurrenceInput, CompleteOccurrenceInput, RescheduleOccurrenceInput, CreateOccurrenceTicketInput, PmSummaryQuery, PmCalendarQuery, PmFrequency } from './schemas';

const P = schema.pmPrograms;
const O = schema.pmOccurrences;
const occEngineer = alias(schema.users, 'occ_engineer');
const progEngineer = alias(schema.users, 'prog_engineer');

/** Occurrence statuses that still expect work. */
export const OPEN_PM_STATUSES = ['planned', 'scheduled', 'rescheduled'];
const occLabel = (o: Pick<OccurrenceRow, 'plannedDate'>, p?: Pick<ProgramRow, 'name'>) => `${p ? `${p.name} ` : 'PM '}${o.plannedDate}`;

// ---------------------------------------------------------------- permissions

function requirePmManage(ctx: Ctx, customerId: string) {
  requireRead(ctx, customerId, 'pm:read');
  if (isCustomerUser(ctx) || !ctx.can('pm:manage', customerId)) throw new ForbiddenError('Missing permission: pm:manage');
}

/** Complete / execute: pm:manage, or field:execute for the engineer assigned to the occurrence / program. */
function requireOccurrenceExecute(ctx: Ctx, occ: OccurrenceRow, program: ProgramRow) {
  requireRead(ctx, occ.customerId, 'pm:read');
  if (isCustomerUser(ctx)) throw new ForbiddenError('This action is not available in the customer portal');
  if (ctx.can('pm:manage', occ.customerId)) return;
  const assigned = (occ.engineerId ?? program.assignedEngineerId) === ctx.user.id;
  if (ctx.can('field:execute', occ.customerId) && assigned) return;
  throw new ForbiddenError('Only the assigned engineer (field:execute) or a maintenance manager (pm:manage) can do this');
}

// ---------------------------------------------------------------- occurrence generation

/** Planned date `k` steps after the start for a frequency (month-based steps never drift: Jan 31 + 1 month → Feb 28). */
export function nthPlannedDate(startDate: string, frequency: string, k: number, intervalDays?: number | null): string {
  switch (frequency as PmFrequency) {
    case 'weekly':
      return addDays(startDate, 7 * k);
    case 'monthly':
      return addMonths(startDate, k);
    case 'quarterly':
      return addMonths(startDate, 3 * k);
    case 'half_yearly':
      return addMonths(startDate, 6 * k);
    case 'annual':
      return addMonths(startDate, 12 * k);
    case 'custom':
    default:
      return addDays(startDate, Math.max(1, intervalDays ?? 30) * k);
  }
}

/** All planned dates of a program up to the horizon (inclusive). */
export function plannedDates(program: Pick<ProgramRow, 'startDate' | 'endDate' | 'frequency' | 'intervalDays'>, horizonMonths = 12, now: Date = new Date()): string[] {
  const horizon = addMonths(todayStr(now), horizonMonths);
  const end = program.endDate && program.endDate < horizon ? program.endDate : horizon;
  const out: string[] = [];
  for (let k = 0; k < 5000; k++) {
    const d = nthPlannedDate(program.startDate, program.frequency, k, program.intervalDays);
    if (d > end) break;
    if (out.length && d <= out[out.length - 1]!) break; // safety against non-advancing schedules
    out.push(d);
  }
  return out;
}

/**
 * Creates the missing `planned` occurrences of a program up to
 * min(endDate, now + horizon). Idempotent: dates that already exist (in any
 * status) are skipped, so re-running never duplicates or resets work.
 */
export async function generateOccurrences(tx: Tx, program: ProgramRow, horizonMonths = 12, now: Date = new Date()): Promise<{ created: number; dates: string[] }> {
  const wanted = plannedDates(program, horizonMonths, now);
  if (!wanted.length) return { created: 0, dates: [] };
  const existing = await tx.select({ plannedDate: O.plannedDate }).from(O).where(eq(O.programId, program.id));
  const have = new Set(existing.map((e) => e.plannedDate));
  const missing = wanted.filter((d) => !have.has(d));
  if (!missing.length) return { created: 0, dates: [] };
  await tx.insert(O).values(missing.map((plannedDate) => ({ programId: program.id, customerId: program.customerId, plannedDate, status: 'planned', engineerId: program.assignedEngineerId ?? null })));
  return { created: missing.length, dates: missing };
}

// ---------------------------------------------------------------- validation

async function assertProgramEntities(tx: Tx, customerId: string, input: { siteId?: string | null; contractId?: string | null; serviceId?: string | null; entitlementId?: string | null; assignedTeamId?: string | null; assignedEngineerId?: string | null; ciIds?: string[]; assetIds?: string[] }) {
  if (input.siteId) {
    const [s] = await tx.select({ customerId: schema.sites.customerId }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).limit(1);
    if (!s || s.customerId !== customerId) throw new ValidationError('Site does not belong to the customer');
  }
  if (input.contractId) {
    const [c] = await tx.select({ customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, input.contractId)).limit(1);
    if (!c || c.customerId !== customerId) throw new ValidationError('Contract does not belong to the customer');
  }
  if (input.serviceId) {
    const [s] = await tx.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    if (!s) throw new ValidationError('Unknown service');
  }
  if (input.entitlementId) {
    const [e] = await tx.select({ customerId: schema.contractEntitlements.customerId, isActive: schema.contractEntitlements.isActive }).from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, input.entitlementId)).limit(1);
    if (!e || e.customerId !== customerId) throw new ValidationError('Entitlement does not belong to the customer');
    if (!e.isActive) throw new ValidationError('Entitlement is inactive');
  }
  if (input.assignedTeamId) {
    const [t] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, input.assignedTeamId)).limit(1);
    if (!t) throw new ValidationError('Unknown team');
  }
  if (input.assignedEngineerId) {
    const [u] = await tx.select({ userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, input.assignedEngineerId)).limit(1);
    if (!u || u.userType !== 'msp' || u.status !== 'active') throw new ValidationError('Engineer must be an active MSP user');
  }
  if (input.ciIds?.length) {
    const ids = [...new Set(input.ciIds)];
    const rows = await tx.select({ id: schema.cis.id, customerId: schema.cis.customerId }).from(schema.cis).where(inArray(schema.cis.id, ids));
    if (rows.length !== ids.length || rows.some((r) => r.customerId !== customerId)) throw new ValidationError('One or more configuration items do not belong to the customer');
  }
  if (input.assetIds?.length) {
    const ids = [...new Set(input.assetIds)];
    const rows = await tx.select({ id: schema.assets.id, customerId: schema.assets.customerId }).from(schema.assets).where(inArray(schema.assets.id, ids));
    if (rows.length !== ids.length || rows.some((r) => r.customerId !== customerId)) throw new ValidationError('One or more assets do not belong to the customer');
  }
}

const normalizeChecklist = (items: { item: string; required?: boolean }[] | undefined | null) => (items ?? []).map((i) => ({ item: i.item, required: !!i.required }));

// ---------------------------------------------------------------- programs

interface ProgramLabels {
  customerName: string | null;
  siteName: string | null;
  contractNumber: string | null;
  contractName: string | null;
  serviceName: string | null;
  teamName: string | null;
  engineerName: string | null;
  entitlementName: string | null;
}

async function programLabels(tx: Tx, rows: ProgramRow[]): Promise<Map<string, ProgramLabels>> {
  const out = new Map<string, ProgramLabels>();
  if (!rows.length) return out;
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const [customers, sites, contracts, services, teams, ents] = await sequential([
    () => tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, uniq(rows.map((r) => r.customerId)))),
    async () => { const ids = uniq(rows.map((r) => r.siteId)); return ids.length ? await tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, ids)) : []; },
    async () => { const ids = uniq(rows.map((r) => r.contractId)); return ids.length ? await tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name }).from(schema.contracts).where(inArray(schema.contracts.id, ids)) : []; },
    async () => { const ids = uniq(rows.map((r) => r.serviceId)); return ids.length ? await tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(inArray(schema.services.id, ids)) : []; },
    async () => { const ids = uniq(rows.map((r) => r.assignedTeamId)); return ids.length ? await tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, ids)) : []; },
    async () => { const ids = uniq(rows.map((r) => r.entitlementId)); return ids.length ? await tx.select({ id: schema.contractEntitlements.id, name: schema.contractEntitlements.name }).from(schema.contractEntitlements).where(inArray(schema.contractEntitlements.id, ids)) : []; },
  ]);
  const users = await userNames(tx, rows.map((r) => r.assignedEngineerId));
  const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const cm = m(customers), sm = m(sites), ctm = m(contracts), svm = m(services), tm = m(teams), em = m(ents);
  for (const r of rows) {
    out.set(r.id, {
      customerName: cm.get(r.customerId)?.name ?? null,
      siteName: r.siteId ? sm.get(r.siteId)?.name ?? null : null,
      contractNumber: r.contractId ? ctm.get(r.contractId)?.number ?? null : null,
      contractName: r.contractId ? ctm.get(r.contractId)?.name ?? null : null,
      serviceName: r.serviceId ? svm.get(r.serviceId)?.name ?? null : null,
      teamName: r.assignedTeamId ? tm.get(r.assignedTeamId)?.name ?? null : null,
      engineerName: r.assignedEngineerId ? users.get(r.assignedEngineerId)?.name ?? null : null,
      entitlementName: r.entitlementId ? em.get(r.entitlementId)?.name ?? null : null,
    });
  }
  return out;
}

interface ProgramStats {
  nextDue: string | null;
  nextStatus: string | null;
  open: number;
  overdue: number;
  completed12m: number;
  missed12m: number;
  total: number;
}

async function programStats(tx: Tx, programIds: string[], now = new Date()): Promise<Map<string, ProgramStats>> {
  const out = new Map<string, ProgramStats>();
  if (!programIds.length) return out;
  const today = todayStr(now);
  const since = addMonths(today, -12);
  const rows = await tx
    .select({
      programId: O.programId,
      nextDue: sql<string | null>`min(coalesce(${O.scheduledDate}, ${O.plannedDate})) filter (where ${O.status} in ('planned','scheduled','rescheduled'))`,
      open: sql<number>`count(*) filter (where ${O.status} in ('planned','scheduled','rescheduled'))::int`,
      overdue: sql<number>`count(*) filter (where ${O.status} in ('planned','scheduled','rescheduled') and coalesce(${O.scheduledDate}, ${O.plannedDate}) < ${today}::date)::int`,
      completed12m: sql<number>`count(*) filter (where ${O.status} = 'completed' and ${O.plannedDate} >= ${since}::date)::int`,
      missed12m: sql<number>`count(*) filter (where ${O.status} = 'missed' and ${O.plannedDate} >= ${since}::date)::int`,
      total: countSql,
    })
    .from(O)
    .where(inArray(O.programId, programIds))
    .groupBy(O.programId);
  for (const id of programIds) out.set(id, { nextDue: null, nextStatus: null, open: 0, overdue: 0, completed12m: 0, missed12m: 0, total: 0 });
  for (const r of rows) out.set(r.programId, { nextDue: r.nextDue, nextStatus: null, open: r.open, overdue: r.overdue, completed12m: r.completed12m, missed12m: r.missed12m, total: r.total });
  return out;
}

function programVisibility(ctx: Ctx, customerId?: string): SQL[] {
  const conds: SQL[] = [];
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access') || !ctx.user.customerId) throw new ForbiddenError('Missing permission: portal:access');
    conds.push(eq(P.customerId, ctx.user.customerId));
    if (customerId && customerId !== ctx.user.customerId) throw new ForbiddenError('You do not have access to this customer');
  } else {
    if (!ctx.can('pm:read') && !ctx.can('pm:manage')) throw new ForbiddenError('Missing permission: pm:read');
    if (customerId) {
      ctx.requireCustomer(customerId);
      conds.push(eq(P.customerId, customerId));
    }
  }
  return conds;
}

export async function listPrograms(ctx: Ctx, q: ProgramListQuery) {
  const conds = programVisibility(ctx, q.customerId);
  if (q.siteId) conds.push(eq(P.siteId, q.siteId));
  if (q.contractId) conds.push(eq(P.contractId, q.contractId));
  if (q.serviceId) conds.push(eq(P.serviceId, q.serviceId));
  if (q.frequency) conds.push(eq(P.frequency, q.frequency));
  if (q.isActive !== undefined) conds.push(eq(P.isActive, q.isActive));
  if (q.assignedTeamId) conds.push(eq(P.assignedTeamId, q.assignedTeamId));
  if (q.assignedEngineerId) conds.push(eq(P.assignedEngineerId, q.assignedEngineerId));
  const like = searchLike(q.q, P.name, P.description);
  if (like) conds.push(like);
  const where = conds.length ? and(...conds) : undefined;
  const total = await countRows(ctx.tx, sql`pm_programs`, where);
  const sortable: Record<string, SQL> = { name: sql`${P.name}`, createdAt: sql`${P.createdAt}`, startDate: sql`${P.startDate}`, frequency: sql`${P.frequency}`, customer: sql`${schema.customers.name}` };
  const col = sortable[q.sort ?? ''] ?? sortable.name!;
  const rows = await ctx.tx
    .select({ p: P })
    .from(P)
    .leftJoin(schema.customers, eq(schema.customers.id, P.customerId))
    .where(where)
    .orderBy(sql`${col} ${q.order === 'desc' ? sql`desc` : sql`asc`}`, asc(P.name))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const programs = rows.map((r) => r.p);
  const [labels, stats] = await sequential([() => programLabels(ctx.tx, programs), () => programStats(ctx.tx, programs.map((p) => p.id))]);
  const items = programs.map((p) => ({ ...p, ...labels.get(p.id)!, ...stats.get(p.id)!, checklistCount: (p.checklist ?? []).length }));
  return { items: isCustomerUser(ctx) ? items.map(({ description: _d, ...rest }) => rest) : items, total, page: q.page, pageSize: q.pageSize };
}

export async function createProgram(ctx: Ctx, input: CreateProgramInput): Promise<ProgramRow> {
  requirePmManage(ctx, input.customerId);
  const tx = ctx.tx;
  const [customer] = await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).limit(1);
  if (!customer) throw new NotFoundError('Customer');
  await assertProgramEntities(tx, input.customerId, input);
  let contractId = input.contractId ?? null;
  if (!contractId) contractId = (await selectContractForTicket(tx, { customerId: input.customerId, serviceId: input.serviceId, siteId: input.siteId }))?.contractId ?? null;
  const entitlementId = input.entitlementId ?? (await autoPickVisitEntitlement(tx, contractId, 'pm_visits', input.serviceId));
  const now = new Date();
  const [program] = await tx
    .insert(P)
    .values({
      customerId: input.customerId,
      siteId: input.siteId ?? null,
      contractId,
      serviceId: input.serviceId ?? null,
      entitlementId,
      name: input.name,
      description: input.description ?? null,
      frequency: input.frequency,
      intervalDays: input.frequency === 'custom' ? input.intervalDays ?? null : null,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      leadDays: input.leadDays ?? 14,
      graceDays: input.graceDays ?? 7,
      checklist: normalizeChecklist(input.checklist),
      assignedTeamId: input.assignedTeamId ?? null,
      assignedEngineerId: input.assignedEngineerId ?? null,
      ciIds: [...new Set(input.ciIds ?? [])],
      assetIds: [...new Set(input.assetIds ?? [])],
      requiresSiteVisit: input.requiresSiteVisit ?? true,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const gen = program.isActive ? await generateOccurrences(tx, program) : { created: 0, dates: [] };
  await ctx.audit({ entityType: 'pm_program', entityId: program.id, entityLabel: program.name, action: 'create', customerId: program.customerId, metadata: { frequency: program.frequency, startDate: program.startDate, endDate: program.endDate, contractId, entitlementId, autoEntitlement: !input.entitlementId && !!entitlementId, occurrencesGenerated: gen.created } });
  return program;
}

export async function getProgram(ctx: Ctx, id: string) {
  const p = await loadProgram(ctx, id);
  const tx = ctx.tx;
  const customer = isCustomerUser(ctx);
  const labels = (await programLabels(tx, [p])).get(p.id)!;
  const stats = (await programStats(tx, [p.id])).get(p.id)!;
  const occRows = await tx
    .select({ o: O, visitNumber: schema.fieldVisits.number, visitStatus: schema.fieldVisits.status, ticketNumber: schema.tickets.number, engineerName: occEngineer.name })
    .from(O)
    .leftJoin(schema.fieldVisits, eq(schema.fieldVisits.id, O.fieldVisitId))
    .leftJoin(schema.tickets, eq(schema.tickets.id, O.ticketId))
    .leftJoin(occEngineer, eq(occEngineer.id, O.engineerId))
    .where(eq(O.programId, p.id))
    .orderBy(asc(O.plannedDate));
  const today = todayStr();
  const occurrences = occRows.map((r) => ({ ...r.o, fieldVisitNumber: r.visitNumber, fieldVisitStatus: r.visitStatus, ticketNumber: r.ticketNumber, engineerName: r.engineerName ?? labels.engineerName, daysUntil: daysBetween(today, r.o.scheduledDate ?? r.o.plannedDate), notes: customer ? null : r.o.notes }));
  const [cis, assets] = await sequential([
    async () => (p.ciIds.length ? await tx.select({ id: schema.cis.id, name: schema.cis.name, hostname: schema.cis.hostname, ipAddress: schema.cis.ipAddress, typeKey: schema.ciTypes.key, typeName: schema.ciTypes.name, typeColor: schema.ciTypes.color, status: schema.cis.status, customerId: schema.cis.customerId }).from(schema.cis).innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId)).where(inArray(schema.cis.id, p.ciIds)) : []),
    async () => (p.assetIds.length ? await tx.select({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name, serialNumber: schema.assets.serialNumber }).from(schema.assets).where(inArray(schema.assets.id, p.assetIds)) : []),
  ]);
  let entitlement: Record<string, unknown> | null = null;
  if (!customer && p.entitlementId) {
    const [ent] = await tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, p.entitlementId)).limit(1);
    if (ent) {
      const tl = await optionLabels(tx, [ent.typeId]);
      entitlement = { id: ent.id, name: ent.name, unit: ent.unit, period: ent.period, quantity: Number(ent.quantity), typeKey: ent.typeId ? tl.get(ent.typeId)?.key ?? null : null, utilization: await entitlementUtilization(tx, ent) };
    }
  }
  const base = { ...p, ...labels, ...stats, occurrences, cis, assets, entitlement, permissions: { canManage: !customer && ctx.can('pm:manage', p.customerId), canCreateVisit: !customer && ctx.can('field:manage', p.customerId) } };
  if (customer) return { ...base, description: p.description, entitlement: null };
  return base;
}

const SCHEDULE_FIELDS = ['frequency', 'intervalDays', 'startDate', 'endDate'] as const;

export async function updateProgram(ctx: Ctx, id: string, patch: UpdateProgramInput): Promise<ProgramRow> {
  const before = await loadProgram(ctx, id);
  requirePmManage(ctx, before.customerId);
  await assertProgramEntities(ctx.tx, before.customerId, patch);
  const values: Partial<typeof P.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'siteId', 'contractId', 'serviceId', 'entitlementId', 'frequency', 'intervalDays', 'startDate', 'endDate', 'leadDays', 'graceDays', 'assignedTeamId', 'assignedEngineerId', 'requiresSiteVisit', 'isActive'] as const) {
    if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.checklist !== undefined) values.checklist = normalizeChecklist(patch.checklist);
  if (patch.ciIds !== undefined) values.ciIds = [...new Set(patch.ciIds)];
  if (patch.assetIds !== undefined) values.assetIds = [...new Set(patch.assetIds)];
  const frequency = values.frequency ?? before.frequency;
  if (frequency === 'custom' && !(values.intervalDays ?? before.intervalDays)) throw new ValidationError('intervalDays is required for a custom frequency');
  if (frequency !== 'custom') values.intervalDays = null;
  const start = values.startDate ?? before.startDate;
  const end = values.endDate !== undefined ? values.endDate : before.endDate;
  if (end && end < start) throw new ValidationError('End date must be after the start date');
  const [after] = await ctx.tx.update(P).set(values).where(eq(P.id, before.id)).returning();
  const changes = diffChanges(before as unknown as Record<string, unknown>, values as Record<string, unknown>);
  const scheduleChanged = SCHEDULE_FIELDS.some((k) => k in changes) || (!before.isActive && after.isActive);
  let generated = 0;
  if (scheduleChanged && after.isActive) {
    // Future untouched occurrences that no longer fit the new cadence are dropped; everything with work stays.
    const keep = new Set(plannedDates(after));
    const today = todayStr();
    const future = await ctx.tx.select().from(O).where(and(eq(O.programId, after.id), eq(O.status, 'planned'), gte(O.plannedDate, today), sql`${O.fieldVisitId} is null`, sql`${O.ticketId} is null`));
    const drop = future.filter((o) => !keep.has(o.plannedDate)).map((o) => o.id);
    if (drop.length) await ctx.tx.delete(O).where(inArray(O.id, drop));
    generated = (await generateOccurrences(ctx.tx, after)).created;
  }
  await ctx.audit({ entityType: 'pm_program', entityId: before.id, entityLabel: after.name, action: 'update', customerId: before.customerId, changes, metadata: scheduleChanged ? { occurrencesGenerated: generated } : undefined });
  return after;
}

/** Drops future untouched occurrences and rebuilds the schedule from the program definition. */
export async function regenerateProgram(ctx: Ctx, id: string) {
  const p = await loadProgram(ctx, id);
  requirePmManage(ctx, p.customerId);
  const today = todayStr();
  const removable = await ctx.tx.select({ id: O.id }).from(O).where(and(eq(O.programId, p.id), eq(O.status, 'planned'), gte(O.plannedDate, today), sql`${O.fieldVisitId} is null`, sql`${O.ticketId} is null`));
  if (removable.length) await ctx.tx.delete(O).where(inArray(O.id, removable.map((r) => r.id)));
  const gen = await generateOccurrences(ctx.tx, p);
  await ctx.audit({ entityType: 'pm_program', entityId: p.id, entityLabel: p.name, action: 'regenerate', customerId: p.customerId, metadata: { removed: removable.length, created: gen.created } });
  return { removed: removable.length, created: gen.created, dates: gen.dates };
}

export async function deleteProgram(ctx: Ctx, id: string) {
  const p = await loadProgram(ctx, id);
  requirePmManage(ctx, p.customerId);
  const [{ completed }] = await ctx.tx.select({ completed: countSql }).from(O).where(and(eq(O.programId, p.id), eq(O.status, 'completed')));
  if (completed > 0) {
    await ctx.tx.update(P).set({ isActive: false, updatedAt: new Date() }).where(eq(P.id, p.id));
    await ctx.audit({ entityType: 'pm_program', entityId: p.id, entityLabel: p.name, action: 'deactivate', customerId: p.customerId, metadata: { completedOccurrences: completed } });
    return { deactivated: true };
  }
  await ctx.tx.delete(P).where(eq(P.id, p.id));
  await ctx.audit({ entityType: 'pm_program', entityId: p.id, entityLabel: p.name, action: 'delete', customerId: p.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- occurrences

const occurrenceColumns = {
  o: O,
  programName: P.name,
  frequency: P.frequency,
  requiresSiteVisit: P.requiresSiteVisit,
  graceDays: P.graceDays,
  leadDays: P.leadDays,
  programActive: P.isActive,
  siteId: P.siteId,
  siteName: schema.sites.name,
  customerName: schema.customers.name,
  teamId: P.assignedTeamId,
  teamName: schema.teams.name,
  engineerName: sql<string | null>`coalesce(${occEngineer.name}, ${progEngineer.name})`,
  effectiveEngineerId: sql<string | null>`coalesce(${O.engineerId}, ${P.assignedEngineerId})`,
  fieldVisitNumber: schema.fieldVisits.number,
  fieldVisitStatus: schema.fieldVisits.status,
  ticketNumber: schema.tickets.number,
};

function occurrenceQuery(tx: Tx) {
  return tx
    .select(occurrenceColumns)
    .from(O)
    .innerJoin(P, eq(P.id, O.programId))
    .leftJoin(schema.customers, eq(schema.customers.id, O.customerId))
    .leftJoin(schema.sites, eq(schema.sites.id, P.siteId))
    .leftJoin(schema.teams, eq(schema.teams.id, P.assignedTeamId))
    .leftJoin(occEngineer, eq(occEngineer.id, O.engineerId))
    .leftJoin(progEngineer, eq(progEngineer.id, P.assignedEngineerId))
    .leftJoin(schema.fieldVisits, eq(schema.fieldVisits.id, O.fieldVisitId))
    .leftJoin(schema.tickets, eq(schema.tickets.id, O.ticketId));
}

type OccurrenceJoined = Awaited<ReturnType<ReturnType<typeof occurrenceQuery>['execute']>>[number];

function occurrenceView(ctx: Ctx, r: OccurrenceJoined, today: string) {
  const { o, ...rest } = r;
  const effectiveDate = o.scheduledDate ?? o.plannedDate;
  const view = { ...o, ...rest, engineerId: r.effectiveEngineerId, effectiveDate, daysUntil: daysBetween(today, effectiveDate), overdue: OPEN_PM_STATUSES.includes(o.status) && effectiveDate < today, dueSoon: o.status === 'planned' && daysBetween(today, o.plannedDate) <= r.leadDays };
  if (isCustomerUser(ctx)) return { ...view, notes: null, rescheduleReason: null };
  return view;
}

function occurrenceVisibility(ctx: Ctx, customerId?: string): SQL[] {
  const conds: SQL[] = [];
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access') || !ctx.user.customerId) throw new ForbiddenError('Missing permission: portal:access');
    conds.push(eq(O.customerId, ctx.user.customerId));
    if (customerId && customerId !== ctx.user.customerId) throw new ForbiddenError('You do not have access to this customer');
  } else {
    if (!ctx.can('pm:read') && !ctx.can('pm:manage')) throw new ForbiddenError('Missing permission: pm:read');
    if (customerId) {
      ctx.requireCustomer(customerId);
      conds.push(eq(O.customerId, customerId));
    }
  }
  return conds;
}

const effectiveDateSql = sql`coalesce(${O.scheduledDate}, ${O.plannedDate})`;
const engineerSql = (id: string) => sql`coalesce(${O.engineerId}, ${P.assignedEngineerId}) = ${id}::uuid`;

export async function listOccurrences(ctx: Ctx, q: OccurrenceListQuery) {
  const conds = occurrenceVisibility(ctx, q.customerId);
  const today = todayStr();
  if (q.programId) conds.push(eq(O.programId, q.programId));
  if (q.siteId) conds.push(eq(P.siteId, q.siteId));
  const statuses = csv(q.status);
  if (statuses.length) conds.push(inArray(O.status, statuses));
  if (q.from) conds.push(gte(O.plannedDate, q.from));
  if (q.to) conds.push(lte(O.plannedDate, q.to));
  if (q.engineerId) conds.push(engineerSql(q.engineerId));
  if (q.mine && !isCustomerUser(ctx)) conds.push(engineerSql(ctx.user.id));
  if (q.teamId) conds.push(eq(P.assignedTeamId, q.teamId));
  if (q.overdue) conds.push(and(inArray(O.status, OPEN_PM_STATUSES), sql`${effectiveDateSql} < ${today}::date`)!);
  const like = searchLike(q.q, P.name);
  if (like) conds.push(like);
  const where = conds.length ? and(...conds) : undefined;
  const total = await countRows(ctx.tx, sql`pm_occurrences join pm_programs on pm_programs.id = pm_occurrences.program_id`, where);
  const sortable: Record<string, SQL> = { plannedDate: sql`${O.plannedDate}`, effectiveDate: effectiveDateSql, status: sql`${O.status}`, program: sql`${P.name}`, customer: sql`${schema.customers.name}`, createdAt: sql`${O.createdAt}` };
  const col = sortable[q.sort ?? ''] ?? sortable.plannedDate!;
  const rows = await occurrenceQuery(ctx.tx)
    .where(where)
    .orderBy(sql`${col} ${q.order === 'desc' ? sql`desc` : sql`asc`}`, asc(O.plannedDate))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items: rows.map((r) => occurrenceView(ctx, r, today)), total, page: q.page, pageSize: q.pageSize };
}

export async function getOccurrence(ctx: Ctx, id: string) {
  await loadOccurrence(ctx, id);
  const [row] = await occurrenceQuery(ctx.tx).where(eq(O.id, id)).limit(1);
  if (!row) throw new NotFoundError('PM occurrence');
  const view = occurrenceView(ctx, row, todayStr());
  const checklist = (await ctx.tx.select({ checklist: P.checklist }).from(P).where(eq(P.id, row.o.programId)).limit(1))[0]?.checklist ?? [];
  return { ...view, checklist };
}

async function notifyPm(ctx: Ctx, event: 'pm.scheduled' | 'pm.due' | 'pm.missed', occ: OccurrenceRow, program: ProgramRow, extra: Record<string, unknown> = {}) {
  const [customer] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, occ.customerId)).limit(1);
  const [site] = program.siteId ? await ctx.tx.select({ name: schema.sites.name }).from(schema.sites).where(eq(schema.sites.id, program.siteId)).limit(1) : [];
  const engineerId = occ.engineerId ?? program.assignedEngineerId;
  const users = await userNames(ctx.tx, [engineerId]);
  const data = {
    pm: {
      occurrenceId: occ.id,
      programId: program.id,
      programName: program.name,
      customerName: customer?.name ?? '',
      siteName: site?.name ?? '',
      date: occ.scheduledDate ?? occ.plannedDate,
      plannedDate: occ.plannedDate,
      scheduledDate: occ.scheduledDate ?? '',
      engineer: engineerId ? users.get(engineerId)?.name ?? '' : '',
      status: occ.status,
      frequency: program.frequency,
      ...extra,
    },
  };
  return notifyFieldEvent(ctx, event, { customerId: occ.customerId, assigneeIds: [engineerId], teamId: program.assignedTeamId }, { data, entityType: 'pm_occurrence', entityId: occ.id, mspLink: pmLink(occ.id), portalLink: pmLink(occ.id, true), body: `${program.name}: ${occ.scheduledDate ?? occ.plannedDate}` });
}
export { notifyPm };

const appendNote = (existing: string | null, line: string) => [existing, `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${line}`].filter(Boolean).join('\n');

/**
 * Schedules an occurrence on a date (and engineer). When `createVisit` is set
 * (default: the program's `requiresSiteVisit`) a preventive-maintenance field
 * visit is created at 10:00 local time (customer time zone) and linked; an
 * existing open visit is rescheduled instead.
 */
export async function scheduleOccurrence(ctx: Ctx, id: string, input: ScheduleOccurrenceInput) {
  const { occurrence: occ, program } = await loadOccurrence(ctx, id);
  requirePmManage(ctx, occ.customerId);
  if (occ.status === 'completed' || occ.status === 'cancelled') throw new ConflictError(`A ${occ.status} occurrence cannot be scheduled`);
  const tx = ctx.tx;
  const engineerId = input.engineerId !== undefined ? input.engineerId : occ.engineerId ?? program.assignedEngineerId;
  if (engineerId) {
    const [u] = await tx.select({ userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, engineerId)).limit(1);
    if (!u || u.userType !== 'msp' || u.status !== 'active') throw new ValidationError('Engineer must be an active MSP user');
  }
  const createVisitWanted = input.createVisit ?? program.requiresSiteVisit;
  const [customer] = await tx.select({ timezone: schema.customers.timezone }).from(schema.customers).where(eq(schema.customers.id, occ.customerId)).limit(1);
  const [site] = program.siteId ? await tx.select({ timezone: schema.sites.timezone }).from(schema.sites).where(eq(schema.sites.id, program.siteId)).limit(1) : [];
  const tz = site?.timezone || customer?.timezone || 'UTC';
  const scheduledStart = zonedDateTime(input.scheduledDate, input.scheduledTime ?? '10:00', tz);
  const scheduledEnd = new Date(scheduledStart.getTime() + (input.durationMinutes ?? 120) * 60_000);

  let fieldVisitId = occ.fieldVisitId;
  let visitNumber: string | null = null;
  const [existingVisit] = fieldVisitId ? await tx.select().from(schema.fieldVisits).where(eq(schema.fieldVisits.id, fieldVisitId)).limit(1) : [];
  if (existingVisit && existingVisit.status !== 'cancelled' && existingVisit.status !== 'completed') {
    if (!ctx.can('field:manage', occ.customerId)) throw new ForbiddenError('Rescheduling the linked field visit requires field:manage');
    if (engineerId) await scheduleVisit(ctx, existingVisit.id, { scheduledStart, scheduledEnd, engineerId, teamId: program.assignedTeamId });
    else await rescheduleVisit(ctx, existingVisit.id, { scheduledStart, scheduledEnd, reason: 'PM occurrence rescheduled' });
    visitNumber = existingVisit.number;
  } else if (createVisitWanted) {
    if (!ctx.can('field:manage', occ.customerId)) throw new ForbiddenError('Creating the field visit requires field:manage');
    const type = await optionByKey(tx, 'field_visit_type', 'preventive_maintenance');
    if (!type) throw new ValidationError('The field_visit_type option "preventive_maintenance" is not configured');
    const visit = await createVisit(
      ctx,
      {
        customerId: occ.customerId,
        siteId: program.siteId,
        contractId: program.contractId,
        serviceId: program.serviceId,
        typeId: type.id,
        title: `PM: ${program.name}`,
        purpose: program.description ?? `Preventive maintenance (${program.frequency.replace(/_/g, ' ')}) planned for ${occ.plannedDate}.`,
        scheduledStart,
        scheduledEnd,
        engineerId,
        teamId: program.assignedTeamId,
        entitlementId: program.entitlementId,
        checklist: (program.checklist as { item: string; required?: boolean }[]).map((c) => ({ item: c.item, required: !!c.required, done: false })),
        billable: false,
      },
      { silent: true, pmOccurrenceId: occ.id },
    );
    fieldVisitId = visit.id;
    visitNumber = visit.number;
    if (occ.ticketId) await tx.update(schema.fieldVisits).set({ ticketId: occ.ticketId }).where(eq(schema.fieldVisits.id, visit.id));
  }
  const values = {
    status: 'scheduled',
    scheduledDate: input.scheduledDate,
    engineerId: engineerId ?? null,
    fieldVisitId,
    notes: input.notes ? appendNote(occ.notes, input.notes) : occ.notes,
    updatedAt: new Date(),
  };
  const [after] = await tx.update(O).set(values).where(eq(O.id, occ.id)).returning();
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: occLabel(occ, program), action: 'schedule', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, values as Record<string, unknown>), metadata: { programId: program.id, visitId: fieldVisitId, visitNumber, createVisit: createVisitWanted } });
  await notifyPm(ctx, 'pm.scheduled', after, program, { visitNumber: visitNumber ?? '' });
  return getOccurrence(ctx, occ.id);
}

/** Completes an occurrence that is handled without a field visit (remote PM, or paperwork after the fact). */
export async function completeOccurrence(ctx: Ctx, id: string, input: CompleteOccurrenceInput) {
  const { occurrence: occ, program } = await loadOccurrence(ctx, id);
  requireOccurrenceExecute(ctx, occ, program);
  if (occ.status === 'completed') throw new ConflictError('The occurrence is already completed');
  if (occ.status === 'cancelled') throw new ConflictError('A cancelled occurrence cannot be completed');
  const tx = ctx.tx;
  const [visit] = occ.fieldVisitId ? await tx.select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, status: schema.fieldVisits.status, entitlementId: schema.fieldVisits.entitlementId, consumptionId: schema.fieldVisits.consumptionId }).from(schema.fieldVisits).where(eq(schema.fieldVisits.id, occ.fieldVisitId)).limit(1) : [];
  if (visit && visit.status !== 'completed' && visit.status !== 'cancelled') throw new ConflictError(`Complete the linked field visit ${visit.number} instead`);
  const completedAt = input.completedAt ?? new Date();
  const results = (input.checklistResults ?? (program.checklist as { item: string; required?: boolean }[]).map((c) => ({ item: c.item, required: !!c.required, done: true, result: 'ok' as const, notes: null }))).map((c) => ({ item: c.item, required: !!c.required, done: c.done ?? true, result: c.result ?? null, notes: c.notes ?? null }));
  const values = { status: 'completed', completedAt, checklistResults: results as Record<string, unknown>[], notes: input.notes ? appendNote(occ.notes, input.notes) : occ.notes, engineerId: occ.engineerId ?? program.assignedEngineerId ?? userIdOf(ctx), updatedAt: new Date() };
  const [after] = await tx.update(O).set(values).where(eq(O.id, occ.id)).returning();
  const meta: Record<string, unknown> = { programId: program.id };
  // Consume the PM entitlement unless the (completed) visit already did.
  const consume = input.consumeEntitlement ?? true;
  if (consume && program.entitlementId) {
    const alreadyByVisit = !!visit?.consumptionId && visit.entitlementId === program.entitlementId;
    const [existing] = await tx.select({ id: schema.entitlementConsumptions.id }).from(schema.entitlementConsumptions).where(and(eq(schema.entitlementConsumptions.sourceType, 'pm'), eq(schema.entitlementConsumptions.sourceId, occ.id))).limit(1);
    if (!alreadyByVisit && !existing) {
      const r = await consumeEntitlement(tx, { entitlementId: program.entitlementId, quantity: 1, sourceType: 'pm', sourceId: occ.id, ticketId: occ.ticketId, notes: `${program.name}: ${occ.plannedDate}`, createdBy: userIdOf(ctx), consumedAt: completedAt });
      meta.consumption = { id: r.consumption.id, entitlementId: program.entitlementId, overage: r.overage };
    }
  }
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: occLabel(occ, program), action: 'complete', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'checklistResults']), metadata: meta });
  if (occ.ticketId) await addActivity(ctx, { id: occ.ticketId, customerId: occ.customerId }, { type: 'pm', summary: `Preventive maintenance "${program.name}" (${occ.plannedDate}) completed`, data: { occurrenceId: occ.id }, customerVisible: true });
  return getOccurrence(ctx, after.id);
}

export async function rescheduleOccurrence(ctx: Ctx, id: string, input: RescheduleOccurrenceInput) {
  const { occurrence: occ, program } = await loadOccurrence(ctx, id);
  requirePmManage(ctx, occ.customerId);
  if (occ.status === 'completed' || occ.status === 'cancelled') throw new ConflictError(`A ${occ.status} occurrence cannot be rescheduled`);
  const tx = ctx.tx;
  const previous = occ.scheduledDate ?? occ.plannedDate;
  const values = {
    status: 'rescheduled',
    scheduledDate: input.scheduledDate,
    rescheduleReason: input.reason,
    notes: appendNote(occ.notes, `Rescheduled from ${previous} to ${input.scheduledDate} by ${ctx.user.name}: ${input.reason}`),
    updatedAt: new Date(),
  };
  const [after] = await tx.update(O).set(values).where(eq(O.id, occ.id)).returning();
  let visitNumber: string | null = null;
  if (occ.fieldVisitId) {
    const [visit] = await tx.select().from(schema.fieldVisits).where(eq(schema.fieldVisits.id, occ.fieldVisitId)).limit(1);
    if (visit && visit.status === 'scheduled') {
      if (!ctx.can('field:manage', occ.customerId)) throw new ForbiddenError('Rescheduling the linked field visit requires field:manage');
      const [customer] = await tx.select({ timezone: schema.customers.timezone }).from(schema.customers).where(eq(schema.customers.id, occ.customerId)).limit(1);
      const time = visit.scheduledStart ? new Intl.DateTimeFormat('en-GB', { timeZone: customer?.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(visit.scheduledStart) : '10:00';
      const start = zonedDateTime(input.scheduledDate, time, customer?.timezone);
      const duration = visit.scheduledStart && visit.scheduledEnd ? visit.scheduledEnd.getTime() - visit.scheduledStart.getTime() : 120 * 60_000;
      await rescheduleVisit(ctx, visit.id, { scheduledStart: start, scheduledEnd: new Date(start.getTime() + duration), reason: input.reason });
      visitNumber = visit.number;
    }
  }
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: occLabel(occ, program), action: 'reschedule', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'notes']), metadata: { reason: input.reason, previousDate: previous, visitNumber } });
  await notifyPm(ctx, 'pm.scheduled', after, program, { rescheduled: true, previousDate: previous, reason: input.reason });
  return getOccurrence(ctx, occ.id);
}

export async function cancelOccurrence(ctx: Ctx, id: string, input: { reason: string }) {
  const { occurrence: occ, program } = await loadOccurrence(ctx, id);
  requirePmManage(ctx, occ.customerId);
  if (occ.status === 'completed') throw new ConflictError('A completed occurrence cannot be cancelled');
  if (occ.status === 'cancelled') throw new ConflictError('The occurrence is already cancelled');
  const tx = ctx.tx;
  let visitCancelled: string | null = null;
  if (occ.fieldVisitId) {
    const [visit] = await tx.select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, status: schema.fieldVisits.status }).from(schema.fieldVisits).where(eq(schema.fieldVisits.id, occ.fieldVisitId)).limit(1);
    if (visit && ['requested', 'scheduled', 'in_progress'].includes(visit.status) && ctx.can('field:manage', occ.customerId)) {
      await cancelVisit(ctx, visit.id, { reason: `PM occurrence cancelled: ${input.reason}` });
      visitCancelled = visit.number;
    }
  }
  const values = { status: 'cancelled', notes: appendNote(occ.notes, `Cancelled by ${ctx.user.name}: ${input.reason}`), updatedAt: new Date() };
  await tx.update(O).set(values).where(eq(O.id, occ.id));
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: occLabel(occ, program), action: 'cancel', customerId: occ.customerId, changes: { status: { old: occ.status, new: 'cancelled' } }, metadata: { reason: input.reason, visitCancelled } });
  return getOccurrence(ctx, occ.id);
}

/** Raises a service request for the maintenance work (type `request`, category preventive_maintenance when configured). */
export async function createOccurrenceTicket(ctx: Ctx, id: string, input: CreateOccurrenceTicketInput) {
  const { occurrence: occ, program } = await loadOccurrence(ctx, id);
  requirePmManage(ctx, occ.customerId);
  if (occ.ticketId) throw new ConflictError('A ticket is already linked to this occurrence');
  if (occ.status === 'cancelled') throw new ConflictError('A cancelled occurrence cannot raise a ticket');
  const category = await optionByKey(ctx.tx, 'ticket_category', 'preventive_maintenance');
  const checklist = (program.checklist as { item: string; required?: boolean }[]).map((c, i) => `${i + 1}. ${c.item}${c.required ? ' (required)' : ''}`).join('\n');
  const ticket = await createTicket(ctx, {
    type: 'request',
    customerId: occ.customerId,
    siteId: program.siteId,
    serviceId: program.serviceId,
    contractId: program.contractId,
    title: input?.title ?? `Preventive maintenance: ${program.name}`,
    description: input?.description ?? [program.description, `Planned date: ${occ.plannedDate}${occ.scheduledDate ? ` (scheduled ${occ.scheduledDate})` : ''}.`, checklist ? `Checklist:\n${checklist}` : null].filter(Boolean).join('\n\n'),
    categoryId: category?.id ?? null,
    priorityId: input?.priorityId ?? null,
    assignedTeamId: program.assignedTeamId,
    assigneeId: occ.engineerId ?? program.assignedEngineerId,
    ciIds: program.ciIds,
    assetIds: program.assetIds,
    tags: ['preventive-maintenance'],
  });
  await ctx.tx.update(O).set({ ticketId: ticket.id, updatedAt: new Date() }).where(eq(O.id, occ.id));
  if (occ.fieldVisitId) await ctx.tx.update(schema.fieldVisits).set({ ticketId: ticket.id }).where(and(eq(schema.fieldVisits.id, occ.fieldVisitId), sql`${schema.fieldVisits.ticketId} is null`));
  await addActivity(ctx, ticket, { type: 'pm', summary: `Raised for preventive maintenance "${program.name}" planned ${occ.plannedDate}`, data: { occurrenceId: occ.id, programId: program.id }, customerVisible: true });
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: occLabel(occ, program), action: 'ticket.create', customerId: occ.customerId, metadata: { ticketId: ticket.id, ticketNumber: ticket.number } });
  return { ticket: { id: ticket.id, number: ticket.number, title: ticket.title }, occurrence: await getOccurrence(ctx, occ.id) };
}

// ---------------------------------------------------------------- summary / calendar

export async function pmSummary(ctx: Ctx, q: PmSummaryQuery) {
  const tx = ctx.tx;
  const today = todayStr();
  const from = q.from ?? addMonths(today, -12);
  const to = q.to ?? addDays(today, 90);
  const base = occurrenceVisibility(ctx, q.customerId);
  const ranged = [...base, gte(O.plannedDate, from), lte(O.plannedDate, to)];
  const [counts, onTime, perCustomer, upcoming, overdue] = await sequential([
    () =>
      tx
        .select({
          planned: sql<number>`count(*) filter (where ${O.status} = 'planned')::int`,
          scheduled: sql<number>`count(*) filter (where ${O.status} = 'scheduled')::int`,
          rescheduled: sql<number>`count(*) filter (where ${O.status} = 'rescheduled')::int`,
          completed: sql<number>`count(*) filter (where ${O.status} = 'completed')::int`,
          missed: sql<number>`count(*) filter (where ${O.status} = 'missed')::int`,
          cancelled: sql<number>`count(*) filter (where ${O.status} = 'cancelled')::int`,
          total: countSql,
        })
        .from(O)
        .innerJoin(P, eq(P.id, O.programId))
        .where(and(...ranged)),
    () =>
      tx
        .select({ completed: countSql, onTime: sql<number>`count(*) filter (where (${O.completedAt} at time zone 'UTC')::date <= ${O.plannedDate} + ${P.graceDays})::int` })
        .from(O)
        .innerJoin(P, eq(P.id, O.programId))
        .where(and(...ranged, eq(O.status, 'completed'))),
    () =>
      tx
        .select({
          customerId: O.customerId,
          customerName: schema.customers.name,
          programs: sql<number>`count(distinct ${O.programId})::int`,
          planned: sql<number>`count(*) filter (where ${O.status} in ('planned','scheduled','rescheduled'))::int`,
          completed: sql<number>`count(*) filter (where ${O.status} = 'completed')::int`,
          missed: sql<number>`count(*) filter (where ${O.status} = 'missed')::int`,
          onTime: sql<number>`count(*) filter (where ${O.status} = 'completed' and (${O.completedAt} at time zone 'UTC')::date <= ${O.plannedDate} + ${P.graceDays})::int`,
        })
        .from(O)
        .innerJoin(P, eq(P.id, O.programId))
        .leftJoin(schema.customers, eq(schema.customers.id, O.customerId))
        .where(and(...ranged))
        .groupBy(O.customerId, schema.customers.name)
        .orderBy(desc(sql`count(*) filter (where ${O.status} = 'missed')`), asc(schema.customers.name))
        .limit(100),
    () =>
      occurrenceQuery(tx)
        .where(and(...base, inArray(O.status, OPEN_PM_STATUSES), sql`${effectiveDateSql} >= ${today}::date`, sql`${effectiveDateSql} <= ${addDays(today, 30)}::date`))
        .orderBy(asc(effectiveDateSql))
        .limit(50),
    () =>
      occurrenceQuery(tx)
        .where(and(...base, inArray(O.status, OPEN_PM_STATUSES), sql`${effectiveDateSql} < ${today}::date`))
        .orderBy(asc(effectiveDateSql))
        .limit(50),
  ]);
  const c = counts[0] ?? { planned: 0, scheduled: 0, rescheduled: 0, completed: 0, missed: 0, cancelled: 0, total: 0 };
  const ot = onTime[0] ?? { completed: 0, onTime: 0 };
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    range: { from, to },
    counts: c,
    onTimePct: pct(ot.onTime, ot.completed),
    completionPct: pct(c.completed, c.completed + c.missed),
    perCustomer: perCustomer.map((r) => ({ ...r, onTimePct: pct(r.onTime, r.completed) })),
    upcoming: upcoming.map((r) => occurrenceView(ctx, r, today)),
    overdue: overdue.map((r) => occurrenceView(ctx, r, today)),
  };
}

export async function pmCalendar(ctx: Ctx, q: PmCalendarQuery) {
  const conds = occurrenceVisibility(ctx, q.customerId);
  conds.push(sql`${effectiveDateSql} >= ${q.from}::date`, sql`${effectiveDateSql} <= ${q.to}::date`);
  if (q.engineerId) conds.push(engineerSql(q.engineerId));
  if (q.teamId) conds.push(eq(P.assignedTeamId, q.teamId));
  const rows = await occurrenceQuery(ctx.tx).where(and(...conds)).orderBy(asc(effectiveDateSql)).limit(2000);
  const today = todayStr();
  return { items: rows.map((r) => occurrenceView(ctx, r, today)) };
}

