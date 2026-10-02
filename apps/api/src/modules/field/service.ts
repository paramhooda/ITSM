import { eq, and, or, inArray, isNull, isNotNull, gte, lt, ne, desc, asc, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { countRows, searchLike } from '@/core/query';
import { selectContractForTicket } from '@/modules/contracts/scope';
import { consumeEntitlement, entitlementUtilization, utilizationBatch } from '@/modules/contracts/entitlements';
import { COVERING_STATUSES } from '@/modules/contracts/schemas';
import { addActivity } from '@/modules/tickets/common';
import {
  type VisitRow,
  type PartRow,
  type NoteRow,
  isCustomerUser,
  userIdOf,
  csv,
  parseRange,
  requireRead,
  requireManage,
  requireExecute,
  canManage,
  canExecute,
  isAssignedEngineer,
  loadVisit,
  reloadVisit,
  optionLabels,
  userNames,
  entitlementTypeKeys,
  autoPickVisitEntitlement,
  notifyFieldEvent,
  visitLink,
  dateInZone,
  sequential,
  countSql,
} from './common';
import type { VisitListQuery, CalendarQuery, CreateVisitInput, UpdateVisitInput, ScheduleVisitInput, CompleteVisitInput, RescheduleVisitInput, AcknowledgeVisitInput, PartInput, NoteInput, SummaryQuery, WorkloadQuery, ChecklistItem } from './schemas';

const V = schema.fieldVisits;
const engineer = alias(schema.users, 'engineer');
const visitType = alias(schema.configOptions, 'visit_type');

/** Statuses from which a visit can still be changed. */
const OPEN_STATUSES = ['requested', 'scheduled', 'in_progress'];

// ---------------------------------------------------------------- numbers

/** Allocates the next visit number (`FV-001234`) from `field_visit_seq`. Never generated client-side. */
export async function nextVisitNumber(tx: Tx): Promise<string> {
  const res = await tx.execute(sql.raw(`SELECT nextval('field_visit_seq')::bigint AS n`));
  const n = Number((res.rows[0] as { n: number | string }).n);
  return `FV-${String(n).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- validation helpers

async function assertCustomerEntities(tx: Tx, customerId: string, input: { siteId?: string | null; ticketId?: string | null; contractId?: string | null; entitlementId?: string | null; serviceId?: string | null }) {
  if (input.siteId) {
    const [s] = await tx.select({ customerId: schema.sites.customerId }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).limit(1);
    if (!s || s.customerId !== customerId) throw new ValidationError('Site does not belong to the customer');
  }
  if (input.ticketId) {
    const [t] = await tx.select({ customerId: schema.tickets.customerId }).from(schema.tickets).where(eq(schema.tickets.id, input.ticketId)).limit(1);
    if (!t || t.customerId !== customerId) throw new ValidationError('Ticket does not belong to the customer');
  }
  if (input.contractId) {
    const [c] = await tx.select({ customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, input.contractId)).limit(1);
    if (!c || c.customerId !== customerId) throw new ValidationError('Contract does not belong to the customer');
  }
  if (input.entitlementId) {
    const [e] = await tx.select({ customerId: schema.contractEntitlements.customerId, isActive: schema.contractEntitlements.isActive }).from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, input.entitlementId)).limit(1);
    if (!e || e.customerId !== customerId) throw new ValidationError('Entitlement does not belong to the customer');
    if (!e.isActive) throw new ValidationError('Entitlement is inactive');
  }
  if (input.serviceId) {
    const [s] = await tx.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    if (!s) throw new ValidationError('Unknown service');
  }
}

async function assertVisitType(tx: Tx, typeId: string) {
  const [opt] = await tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, typeId)).limit(1);
  if (!opt || opt.type !== 'field_visit_type') throw new ValidationError('Invalid visit type');
  return opt;
}

async function assertEngineers(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return;
  const rows = await tx.select({ id: schema.users.id, userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, clean));
  if (rows.length !== clean.length || rows.some((u) => u.userType !== 'msp' || u.status !== 'active')) throw new ValidationError('Engineers must be active MSP users');
}

async function assertTeam(tx: Tx, teamId: string | null | undefined) {
  if (!teamId) return;
  const [t] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  if (!t) throw new ValidationError('Unknown team');
}

function assertSchedule(start: Date | null | undefined, end: Date | null | undefined) {
  if (start && end && end.getTime() < start.getTime()) throw new ValidationError('Scheduled end must be after the scheduled start');
}

const normalizeChecklist = (items: ChecklistItem[] | undefined | null) => (items ?? []).map((i) => ({ item: i.item, required: !!i.required, done: !!i.done, result: i.result ?? null, notes: i.notes ?? null }));

async function visitTicketActivity(ctx: Ctx, v: Pick<VisitRow, 'ticketId' | 'customerId' | 'id' | 'number' | 'status' | 'title'>, summary: string, data: Record<string, unknown> = {}) {
  if (!v.ticketId) return;
  await addActivity(ctx, { id: v.ticketId, customerId: v.customerId }, { type: 'field_visit', summary, data: { visitId: v.id, visitNumber: v.number, status: v.status, ...data }, customerVisible: true });
}

// ---------------------------------------------------------------- decoration

export interface VisitLabels {
  customerName: string | null;
  customerCode: string | null;
  siteName: string | null;
  engineerName: string | null;
  teamName: string | null;
  typeLabel: string | null;
  typeKey: string | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  contractNumber: string | null;
  contractName: string | null;
  serviceName: string | null;
  pmProgramId: string | null;
  pmProgramName: string | null;
  entitlementName: string | null;
  requestedByName: string | null;
  additionalEngineers: { id: string; name: string }[];
}

async function labelsFor(tx: Tx, rows: VisitRow[]): Promise<Map<string, VisitLabels>> {
  const out = new Map<string, VisitLabels>();
  if (!rows.length) return out;
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const customerIds = uniq(rows.map((r) => r.customerId));
  const siteIds = uniq(rows.map((r) => r.siteId));
  const teamIds = uniq(rows.map((r) => r.teamId));
  const ticketIds = uniq(rows.map((r) => r.ticketId));
  const contractIds = uniq(rows.map((r) => r.contractId));
  const serviceIds = uniq(rows.map((r) => r.serviceId));
  const occIds = uniq(rows.map((r) => r.pmOccurrenceId));
  const entIds = uniq(rows.map((r) => r.entitlementId));
  const [customers, sites, teams, tickets, contracts, services, occs, ents] = await sequential([
    () => tx.select({ id: schema.customers.id, name: schema.customers.name, code: schema.customers.code }).from(schema.customers).where(inArray(schema.customers.id, customerIds)),
    async () => (siteIds.length ? await tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, siteIds)) : []),
    async () => (teamIds.length ? await tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds)) : []),
    async () => (ticketIds.length ? await tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(inArray(schema.tickets.id, ticketIds)) : []),
    async () => (contractIds.length ? await tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name }).from(schema.contracts).where(inArray(schema.contracts.id, contractIds)) : []),
    async () => (serviceIds.length ? await tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(inArray(schema.services.id, serviceIds)) : []),
    async () =>
      occIds.length
        ? await tx
            .select({ id: schema.pmOccurrences.id, programId: schema.pmPrograms.id, programName: schema.pmPrograms.name })
            .from(schema.pmOccurrences)
            .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
            .where(inArray(schema.pmOccurrences.id, occIds))
        : [],
    async () => (entIds.length ? await tx.select({ id: schema.contractEntitlements.id, name: schema.contractEntitlements.name }).from(schema.contractEntitlements).where(inArray(schema.contractEntitlements.id, entIds)) : []),
  ]);
  const users = await userNames(tx, rows.flatMap((r) => [r.engineerId, r.requestedBy, ...(r.additionalEngineerIds ?? [])]));
  const types = await optionLabels(tx, rows.map((r) => r.typeId));
  const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const cm = m(customers), sm = m(sites), tm = m(teams), tk = m(tickets), ctm = m(contracts), svm = m(services), om = m(occs), em = m(ents);
  for (const r of rows) {
    const t = r.typeId ? types.get(r.typeId) : undefined;
    const occ = r.pmOccurrenceId ? om.get(r.pmOccurrenceId) : undefined;
    out.set(r.id, {
      customerName: cm.get(r.customerId)?.name ?? null,
      customerCode: cm.get(r.customerId)?.code ?? null,
      siteName: r.siteId ? sm.get(r.siteId)?.name ?? null : null,
      engineerName: r.engineerId ? users.get(r.engineerId)?.name ?? null : null,
      teamName: r.teamId ? tm.get(r.teamId)?.name ?? null : null,
      typeLabel: t?.label ?? null,
      typeKey: t?.key ?? null,
      ticketNumber: r.ticketId ? tk.get(r.ticketId)?.number ?? null : null,
      ticketTitle: r.ticketId ? tk.get(r.ticketId)?.title ?? null : null,
      contractNumber: r.contractId ? ctm.get(r.contractId)?.number ?? null : null,
      contractName: r.contractId ? ctm.get(r.contractId)?.name ?? null : null,
      serviceName: r.serviceId ? svm.get(r.serviceId)?.name ?? null : null,
      pmProgramId: occ?.programId ?? null,
      pmProgramName: occ?.programName ?? null,
      entitlementName: r.entitlementId ? em.get(r.entitlementId)?.name ?? null : null,
      requestedByName: r.requestedBy ? users.get(r.requestedBy)?.name ?? null : null,
      additionalEngineers: (r.additionalEngineerIds ?? []).map((id) => ({ id, name: users.get(id)?.name ?? 'Unknown' })),
    });
  }
  return out;
}

/** Fields a customer (portal) user may see. No internal notes, entitlement or custom fields. */
export function customerSafeVisit<T extends VisitRow & Partial<VisitLabels>>(v: T) {
  return {
    id: v.id,
    number: v.number,
    customerId: v.customerId,
    customerName: v.customerName ?? null,
    siteId: v.siteId,
    siteName: v.siteName ?? null,
    ticketId: v.ticketId,
    ticketNumber: v.ticketNumber ?? null,
    typeId: v.typeId,
    typeLabel: v.typeLabel ?? null,
    typeKey: v.typeKey ?? null,
    title: v.title,
    purpose: v.purpose,
    status: v.status,
    engineerId: v.engineerId,
    engineerName: v.engineerName ?? null,
    teamName: v.teamName ?? null,
    scheduledStart: v.scheduledStart,
    scheduledEnd: v.scheduledEnd,
    actualStart: v.actualStart,
    actualEnd: v.actualEnd,
    workMinutes: v.workMinutes,
    travelMinutes: v.travelMinutes,
    workSummary: v.workSummary,
    findings: v.findings,
    recommendations: v.recommendations,
    checklist: v.checklist,
    customerAckName: v.customerAckName,
    customerAckTitle: v.customerAckTitle,
    customerAckAt: v.customerAckAt,
    customerAckNotes: v.customerAckNotes,
    customerRating: v.customerRating,
    reportGeneratedAt: v.reportGeneratedAt,
    pmProgramName: v.pmProgramName ?? null,
    cancelReason: v.cancelReason,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export type VisitListRow = VisitRow & VisitLabels & { acknowledged: boolean };

// ---------------------------------------------------------------- list / calendar

export function visibilityConds(ctx: Ctx, customerId?: string): SQL[] {
  const conds: SQL[] = [];
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access')) throw new ForbiddenError('Missing permission: portal:access');
    if (!ctx.user.customerId) throw new ForbiddenError('Customer context required');
    conds.push(eq(V.customerId, ctx.user.customerId));
    if (customerId && customerId !== ctx.user.customerId) throw new ForbiddenError('You do not have access to this customer');
  } else {
    if (!ctx.can('field:read') && !ctx.can('field:manage')) throw new ForbiddenError('Missing permission: field:read');
    if (customerId) {
      ctx.requireCustomer(customerId);
      conds.push(eq(V.customerId, customerId));
    }
  }
  return conds;
}

function engineerCond(engineerId: string) {
  return or(eq(V.engineerId, engineerId), sql`${engineerId}::uuid = ANY(${V.additionalEngineerIds})`)!;
}

function buildWhere(ctx: Ctx, q: VisitListQuery): SQL | undefined {
  const conds = visibilityConds(ctx, q.customerId);
  if (q.siteId) conds.push(eq(V.siteId, q.siteId));
  const statuses = csv(q.status);
  if (statuses.length) conds.push(inArray(V.status, statuses));
  if (q.engineerId) conds.push(engineerCond(q.engineerId));
  if (q.mine && !isCustomerUser(ctx)) conds.push(engineerCond(ctx.user.id));
  if (q.teamId) conds.push(eq(V.teamId, q.teamId));
  if (q.typeId) conds.push(eq(V.typeId, q.typeId));
  if (q.ticketId) conds.push(eq(V.ticketId, q.ticketId));
  if (q.contractId) conds.push(eq(V.contractId, q.contractId));
  if (q.pmProgramId) conds.push(sql`EXISTS (SELECT 1 FROM pm_occurrences o WHERE o.id = ${V.pmOccurrenceId} AND o.program_id = ${q.pmProgramId}::uuid)`);
  const range = parseRange(q.from, q.to);
  if (range.from) conds.push(gte(V.scheduledStart, range.from));
  if (range.to) conds.push(lt(V.scheduledStart, range.to));
  if (q.unacknowledged) conds.push(and(eq(V.status, 'completed'), isNull(V.customerAckAt))!);
  if (q.unassigned) conds.push(and(inArray(V.status, ['requested', 'scheduled']), isNull(V.engineerId))!);
  if (q.overdue) conds.push(and(eq(V.status, 'scheduled'), lt(V.scheduledStart, new Date()))!);
  const like = searchLike(q.q, V.number, V.title);
  if (like) conds.push(like);
  return conds.length ? and(...conds) : undefined;
}

export async function listVisits(ctx: Ctx, q: VisitListQuery) {
  const where = buildWhere(ctx, q);
  const total = await countRows(ctx.tx, sql`field_visits`, where);
  const sortable: Record<string, { col: SQL; nullsLast?: boolean }> = {
    scheduledStart: { col: sql`${V.scheduledStart}`, nullsLast: true },
    createdAt: { col: sql`${V.createdAt}` },
    updatedAt: { col: sql`${V.updatedAt}` },
    status: { col: sql`${V.status}` },
    number: { col: sql`${V.number}` },
    title: { col: sql`${V.title}` },
    customer: { col: sql`${schema.customers.name}` },
    engineer: { col: sql`${engineer.name}`, nullsLast: true },
  };
  const sortDef = sortable[q.sort ?? ''] ?? sortable.scheduledStart!;
  const dir = q.order === 'asc' ? sql`asc` : sql`desc`;
  const order = sql`${sortDef.col} ${dir}${sortDef.nullsLast ? sql` NULLS LAST` : sql``}`;
  const rows = await ctx.tx
    .select({ v: V })
    .from(V)
    .leftJoin(schema.customers, eq(schema.customers.id, V.customerId))
    .leftJoin(engineer, eq(engineer.id, V.engineerId))
    .where(where)
    .orderBy(order, desc(V.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const visits = rows.map((r) => r.v);
  const labels = await labelsFor(ctx.tx, visits);
  const items = visits.map((v) => ({ ...v, ...labels.get(v.id)!, acknowledged: !!v.customerAckAt }));
  return { items: isCustomerUser(ctx) ? items.map(customerSafeVisit) : items, total, page: q.page, pageSize: q.pageSize };
}

/** Compact rows for calendar views (week grid by engineer × day). */
export async function calendarVisits(ctx: Ctx, q: CalendarQuery) {
  const conds = visibilityConds(ctx, q.customerId);
  const range = parseRange(q.from, q.to);
  if (!range.from || !range.to) throw new ValidationError('from and to are required');
  conds.push(gte(V.scheduledStart, range.from), lt(V.scheduledStart, range.to));
  if (!q.includeCancelled) conds.push(ne(V.status, 'cancelled'));
  if (q.engineerId) conds.push(engineerCond(q.engineerId));
  if (q.teamId) conds.push(eq(V.teamId, q.teamId));
  const rows = await ctx.tx
    .select({
      id: V.id,
      number: V.number,
      title: V.title,
      status: V.status,
      customerId: V.customerId,
      customerName: schema.customers.name,
      siteName: schema.sites.name,
      engineerId: V.engineerId,
      engineerName: engineer.name,
      teamId: V.teamId,
      additionalEngineerIds: V.additionalEngineerIds,
      typeLabel: visitType.label,
      typeKey: visitType.key,
      scheduledStart: V.scheduledStart,
      scheduledEnd: V.scheduledEnd,
      acknowledged: isNotNull(V.customerAckAt),
    })
    .from(V)
    .leftJoin(schema.customers, eq(schema.customers.id, V.customerId))
    .leftJoin(schema.sites, eq(schema.sites.id, V.siteId))
    .leftJoin(engineer, eq(engineer.id, V.engineerId))
    .leftJoin(visitType, eq(visitType.id, V.typeId))
    .where(and(...conds))
    .orderBy(asc(V.scheduledStart))
    .limit(2000);
  return { items: rows };
}

// ---------------------------------------------------------------- create / read / update

export interface CreateVisitOptions {
  /** Suppress the field_visit.scheduled notification (the caller sends its own, e.g. pm.scheduled). */
  silent?: boolean;
  pmOccurrenceId?: string | null;
  requestedBy?: string | null;
}

export async function createVisit(ctx: Ctx, input: CreateVisitInput, opts: CreateVisitOptions = {}): Promise<VisitRow> {
  requireManage(ctx, input.customerId);
  const tx = ctx.tx;
  const [customer] = await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).limit(1);
  if (!customer) throw new NotFoundError('Customer');
  await assertCustomerEntities(tx, input.customerId, input);
  const type = await assertVisitType(tx, input.typeId);
  await assertEngineers(tx, [input.engineerId, ...(input.additionalEngineerIds ?? [])]);
  await assertTeam(tx, input.teamId);
  assertSchedule(input.scheduledStart, input.scheduledEnd);

  // Contract default: the ticket's contract, else the covering contract for the service/site.
  let contractId = input.contractId ?? null;
  let serviceId = input.serviceId ?? null;
  if (input.ticketId) {
    const [t] = await tx.select({ contractId: schema.tickets.contractId, serviceId: schema.tickets.serviceId, siteId: schema.tickets.siteId }).from(schema.tickets).where(eq(schema.tickets.id, input.ticketId)).limit(1);
    if (!contractId && t?.contractId) contractId = t.contractId;
    if (!serviceId && t?.serviceId) serviceId = t.serviceId;
  }
  if (!contractId) {
    const sel = await selectContractForTicket(tx, { customerId: input.customerId, serviceId, siteId: input.siteId });
    contractId = sel?.contractId ?? null;
  }
  // Entitlement default: pm_visits for preventive maintenance, site_visits otherwise.
  const entitlementId = input.entitlementId ?? (await autoPickVisitEntitlement(tx, contractId, type.key === 'preventive_maintenance' ? 'pm_visits' : 'site_visits', serviceId));
  const scheduled = !!input.scheduledStart && !!input.engineerId;
  const status = scheduled ? 'scheduled' : 'requested';
  const now = new Date();
  const number = await nextVisitNumber(tx);
  const [visit] = await tx
    .insert(V)
    .values({
      number,
      customerId: input.customerId,
      siteId: input.siteId ?? null,
      ticketId: input.ticketId ?? null,
      contractId,
      serviceId,
      typeId: type.id,
      pmOccurrenceId: opts.pmOccurrenceId ?? null,
      title: input.title,
      purpose: input.purpose ?? null,
      status,
      engineerId: input.engineerId ?? null,
      teamId: input.teamId ?? null,
      additionalEngineerIds: [...new Set((input.additionalEngineerIds ?? []).filter((id) => id !== input.engineerId))],
      requestedBy: opts.requestedBy ?? userIdOf(ctx),
      scheduledStart: input.scheduledStart ?? null,
      scheduledEnd: input.scheduledEnd ?? null,
      entitlementId,
      billable: input.billable ?? false,
      checklist: normalizeChecklist(input.checklist),
      customFields: input.customFields ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await visitTicketActivity(ctx, visit, `Field visit ${number} ${status === 'scheduled' ? 'scheduled' : 'requested'}: ${visit.title}`);
  await ctx.audit({ entityType: 'field_visit', entityId: visit.id, entityLabel: number, action: 'create', customerId: visit.customerId, metadata: { status, typeKey: type.key, title: visit.title, ticketId: visit.ticketId, contractId, entitlementId, autoEntitlement: !input.entitlementId && !!entitlementId, pmOccurrenceId: visit.pmOccurrenceId } });
  if (scheduled && !opts.silent) await notifyVisit(ctx, visit, 'field_visit.scheduled');
  return visit;
}

async function notifyVisit(ctx: Ctx, v: VisitRow, event: 'field_visit.scheduled' | 'field_visit.completed') {
  const labels = (await labelsFor(ctx.tx, [v])).get(v.id)!;
  const data = {
    visit: {
      id: v.id,
      number: v.number,
      title: v.title,
      customerName: labels.customerName ?? '',
      siteName: labels.siteName ?? '',
      scheduledStart: v.scheduledStart?.toISOString() ?? '',
      scheduledEnd: v.scheduledEnd?.toISOString() ?? '',
      engineer: labels.engineerName ?? '',
      workSummary: v.workSummary ?? '',
      findings: v.findings ?? '',
      recommendations: v.recommendations ?? '',
      status: v.status,
      typeLabel: labels.typeLabel ?? '',
      purpose: v.purpose ?? '',
      ticketNumber: labels.ticketNumber ?? '',
    },
  };
  return notifyFieldEvent(ctx, event, { customerId: v.customerId, assigneeIds: [v.engineerId, ...(v.additionalEngineerIds ?? [])], teamId: v.teamId, requesterUserId: v.requestedBy }, { data, entityType: 'field_visit', entityId: v.id, mspLink: visitLink(v.id), portalLink: visitLink(v.id, true), body: `${v.number} ${v.title}` });
}

export async function getVisit(ctx: Ctx, id: string) {
  const v = await loadVisit(ctx, id);
  const tx = ctx.tx;
  const customer = isCustomerUser(ctx);
  const labels = (await labelsFor(tx, [v])).get(v.id)!;
  const [parts, notes, attachmentCount, timeEntries] = await sequential([
    () => tx.select().from(schema.fieldVisitParts).where(eq(schema.fieldVisitParts.visitId, v.id)).orderBy(asc(schema.fieldVisitParts.createdAt)),
    () => tx.select().from(schema.fieldVisitNotes).where(customer ? and(eq(schema.fieldVisitNotes.visitId, v.id), eq(schema.fieldVisitNotes.isInternal, false)) : eq(schema.fieldVisitNotes.visitId, v.id)).orderBy(asc(schema.fieldVisitNotes.createdAt)),
    async () => (await tx.select({ count: countSql }).from(schema.attachments).where(and(eq(schema.attachments.entityType, 'field_visit'), eq(schema.attachments.entityId, v.id), ...(customer ? [eq(schema.attachments.customerVisible, true)] : []))))[0]?.count ?? 0,
    async () =>
      customer
        ? []
        : await tx
            .select({ id: schema.timeEntries.id, userId: schema.timeEntries.userId, userName: schema.users.name, minutes: schema.timeEntries.minutes, workType: schema.timeEntries.workType, billable: schema.timeEntries.billable, startedAt: schema.timeEntries.startedAt, description: schema.timeEntries.description, entitlementId: schema.timeEntries.entitlementId, consumptionId: schema.timeEntries.consumptionId, createdAt: schema.timeEntries.createdAt })
            .from(schema.timeEntries)
            .leftJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
            .where(eq(schema.timeEntries.fieldVisitId, v.id))
            .orderBy(desc(schema.timeEntries.createdAt)),
  ]);
  const assetIds = [...new Set(parts.map((p) => p.assetId).filter((x): x is string => !!x))];
  const assets = assetIds.length ? await tx.select({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name }).from(schema.assets).where(inArray(schema.assets.id, assetIds)) : [];
  const assetMap = new Map(assets.map((a) => [a.id, a]));
  const partViews = parts.map((p) => ({ ...p, quantity: Number(p.quantity), unitCost: p.unitCost === null ? null : Number(p.unitCost), assetTag: p.assetId ? assetMap.get(p.assetId)?.tag ?? null : null, assetName: p.assetId ? assetMap.get(p.assetId)?.name ?? null : null }));

  // Linked ticket summary
  let ticket: { id: string; number: string; title: string; type: string; status: string | null; statusColor: string | null; assigneeName: string | null } | null = null;
  if (v.ticketId) {
    const [t] = await tx
      .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, type: schema.tickets.type, status: schema.configOptions.label, statusColor: schema.configOptions.color, assigneeName: engineer.name })
      .from(schema.tickets)
      .leftJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId))
      .leftJoin(engineer, eq(engineer.id, schema.tickets.assigneeId))
      .where(eq(schema.tickets.id, v.ticketId))
      .limit(1);
    ticket = t ?? null;
  }
  // PM occurrence
  let pmOccurrence: { id: string; programId: string; programName: string; plannedDate: string; scheduledDate: string | null; status: string; frequency: string } | null = null;
  if (v.pmOccurrenceId) {
    const [o] = await tx
      .select({ id: schema.pmOccurrences.id, programId: schema.pmOccurrences.programId, programName: schema.pmPrograms.name, plannedDate: schema.pmOccurrences.plannedDate, scheduledDate: schema.pmOccurrences.scheduledDate, status: schema.pmOccurrences.status, frequency: schema.pmPrograms.frequency })
      .from(schema.pmOccurrences)
      .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
      .where(eq(schema.pmOccurrences.id, v.pmOccurrenceId))
      .limit(1);
    pmOccurrence = o ?? null;
  }
  if (customer) {
    return { ...customerSafeVisit({ ...v, ...labels }), parts: partViews, notes, attachmentCount, ticket: ticket ? { id: ticket.id, number: ticket.number, title: ticket.title, type: ticket.type, status: ticket.status } : null, pmOccurrence, permissions: { canManage: false, canExecute: false, canAcknowledge: v.status === 'completed' && !v.customerAckAt, canNote: v.status !== 'cancelled' } };
  }
  // Entitlement + consumption (MSP only)
  let entitlement: Record<string, unknown> | null = null;
  if (v.entitlementId) {
    const [ent] = await tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, v.entitlementId)).limit(1);
    if (ent) {
      const typeLabels = await optionLabels(tx, [ent.typeId]);
      entitlement = { id: ent.id, name: ent.name, unit: ent.unit, period: ent.period, quantity: Number(ent.quantity), typeKey: ent.typeId ? typeLabels.get(ent.typeId)?.key ?? null : null, typeLabel: ent.typeId ? typeLabels.get(ent.typeId)?.label ?? null : null, contractId: ent.contractId, utilization: await entitlementUtilization(tx, ent) };
    }
  }
  let consumption: { id: string; quantity: number; consumedAt: Date; entitlementId: string } | null = null;
  if (v.consumptionId) {
    const [c] = await tx.select({ id: schema.entitlementConsumptions.id, quantity: schema.entitlementConsumptions.quantity, consumedAt: schema.entitlementConsumptions.consumedAt, entitlementId: schema.entitlementConsumptions.entitlementId }).from(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.id, v.consumptionId)).limit(1);
    consumption = c ? { ...c, quantity: Number(c.quantity) } : null;
  }
  const noteAuthors = await userNames(tx, notes.map((n) => n.authorId));
  return {
    ...v,
    ...labels,
    acknowledged: !!v.customerAckAt,
    parts: partViews,
    notes: notes.map((n) => ({ ...n, authorName: n.authorName ?? (n.authorId ? noteAuthors.get(n.authorId)?.name ?? null : null) })),
    attachmentCount,
    timeEntries: timeEntries as (typeof timeEntries)[number][],
    ticket,
    pmOccurrence,
    entitlement,
    consumption,
    permissions: permissionsFor(ctx, v),
  };
}

export function permissionsFor(ctx: Ctx, v: VisitRow) {
  const manage = canManage(ctx, v.customerId);
  const execute = canExecute(ctx, v);
  const open = OPEN_STATUSES.includes(v.status);
  return {
    canManage: manage,
    canExecute: execute,
    canEdit: manage && v.status !== 'cancelled',
    canSchedule: manage && (v.status === 'requested' || v.status === 'scheduled'),
    canStart: execute && (v.status === 'scheduled' || v.status === 'requested'),
    canComplete: execute && (v.status === 'in_progress' || v.status === 'scheduled'),
    canReschedule: manage && v.status === 'scheduled',
    canCancel: manage && open,
    canAcknowledge: (execute || manage) && v.status === 'completed' && !v.customerAckAt,
    canNote: (execute || manage) && v.status !== 'cancelled',
    canParts: (execute || manage) && v.status !== 'cancelled',
    canReport: (execute || manage) && (v.status === 'completed' || v.status === 'in_progress'),
    isAssigned: isAssignedEngineer(ctx, v),
  };
}

/** Fields editable after completion (narrative + checklist only). */
const COMPLETED_EDITABLE = new Set(['title', 'purpose', 'checklist', 'billable', 'customFields', 'serviceId']);

export async function updateVisit(ctx: Ctx, id: string, patch: UpdateVisitInput): Promise<VisitRow> {
  const before = await loadVisit(ctx, id);
  requireManage(ctx, before.customerId);
  if (before.status === 'cancelled') throw new ConflictError('A cancelled visit cannot be edited');
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (before.status === 'completed' && keys.some((k) => !COMPLETED_EDITABLE.has(k))) throw new ConflictError('Only the title, purpose, checklist, billing flag and custom fields can be changed after completion');
  await assertCustomerEntities(ctx.tx, before.customerId, patch);
  if (patch.typeId) await assertVisitType(ctx.tx, patch.typeId);
  await assertEngineers(ctx.tx, [patch.engineerId, ...(patch.additionalEngineerIds ?? [])]);
  await assertTeam(ctx.tx, patch.teamId);
  const values: Partial<typeof V.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['siteId', 'ticketId', 'contractId', 'serviceId', 'typeId', 'title', 'purpose', 'engineerId', 'teamId', 'entitlementId', 'billable', 'customFields'] as const) {
    if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.additionalEngineerIds !== undefined) values.additionalEngineerIds = [...new Set(patch.additionalEngineerIds.filter((x) => x !== (patch.engineerId ?? before.engineerId)))];
  if (patch.checklist !== undefined) values.checklist = normalizeChecklist(patch.checklist);
  if (patch.scheduledStart !== undefined) values.scheduledStart = patch.scheduledStart;
  if (patch.scheduledEnd !== undefined) values.scheduledEnd = patch.scheduledEnd;
  assertSchedule(values.scheduledStart ?? before.scheduledStart, values.scheduledEnd ?? before.scheduledEnd);
  // A requested visit becomes scheduled once it has both a date and an engineer.
  const start = values.scheduledStart !== undefined ? values.scheduledStart : before.scheduledStart;
  const eng = values.engineerId !== undefined ? values.engineerId : before.engineerId;
  if (before.status === 'requested' && start && eng) values.status = 'scheduled';
  const [after] = await ctx.tx.update(V).set(values).where(eq(V.id, before.id)).returning();
  const changes = diffChanges(before as unknown as Record<string, unknown>, values as Record<string, unknown>);
  await ctx.audit({ entityType: 'field_visit', entityId: before.id, entityLabel: before.number, action: 'update', customerId: before.customerId, changes });
  if (values.status === 'scheduled') {
    await visitTicketActivity(ctx, after, `Field visit ${after.number} scheduled`);
    await notifyVisit(ctx, after, 'field_visit.scheduled');
  }
  return after;
}

// ---------------------------------------------------------------- workflow

export async function scheduleVisit(ctx: Ctx, id: string, input: ScheduleVisitInput): Promise<VisitRow> {
  const v = await loadVisit(ctx, id);
  requireManage(ctx, v.customerId);
  if (v.status !== 'requested' && v.status !== 'scheduled') throw new ConflictError(`A ${v.status.replace(/_/g, ' ')} visit cannot be scheduled`);
  await assertEngineers(ctx.tx, [input.engineerId, ...(input.additionalEngineerIds ?? [])]);
  await assertTeam(ctx.tx, input.teamId);
  assertSchedule(input.scheduledStart, input.scheduledEnd);
  const values: Partial<typeof V.$inferInsert> = {
    status: 'scheduled',
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd ?? null,
    engineerId: input.engineerId,
    teamId: input.teamId !== undefined ? input.teamId : v.teamId,
    additionalEngineerIds: input.additionalEngineerIds !== undefined ? [...new Set(input.additionalEngineerIds.filter((x) => x !== input.engineerId))] : v.additionalEngineerIds.filter((x) => x !== input.engineerId),
    updatedAt: new Date(),
  };
  const [after] = await ctx.tx.update(V).set(values).where(eq(V.id, v.id)).returning();
  await syncOccurrenceSchedule(ctx, after);
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'schedule', customerId: v.customerId, changes: diffChanges(v as unknown as Record<string, unknown>, values as Record<string, unknown>) });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} scheduled for ${input.scheduledStart.toISOString()}`, { scheduledStart: input.scheduledStart.toISOString(), engineerId: input.engineerId });
  await notifyVisit(ctx, after, 'field_visit.scheduled');
  return after;
}

/** Keeps the linked PM occurrence's scheduled date / engineer aligned with the visit. */
async function syncOccurrenceSchedule(ctx: Ctx, v: VisitRow) {
  if (!v.pmOccurrenceId || !v.scheduledStart) return;
  const [occ] = await ctx.tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, v.pmOccurrenceId)).limit(1);
  if (!occ || ['completed', 'cancelled'].includes(occ.status)) return;
  const [cust] = await ctx.tx.select({ timezone: schema.customers.timezone }).from(schema.customers).where(eq(schema.customers.id, v.customerId)).limit(1);
  const scheduledDate = dateInZone(v.scheduledStart, cust?.timezone);
  const values = { scheduledDate, engineerId: v.engineerId ?? occ.engineerId, status: occ.status === 'planned' ? 'scheduled' : occ.status, updatedAt: new Date() };
  await ctx.tx.update(schema.pmOccurrences).set(values).where(eq(schema.pmOccurrences.id, occ.id));
  await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: `PM ${occ.plannedDate}`, action: 'schedule', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, values as Record<string, unknown>), metadata: { visitId: v.id, visitNumber: v.number } });
}

export async function startVisit(ctx: Ctx, id: string, input?: { actualStart?: Date }): Promise<VisitRow> {
  const v = await loadVisit(ctx, id);
  // An unassigned requested visit may be picked up by any engineer holding field:execute.
  const pickUp = !v.engineerId && !isCustomerUser(ctx) && ctx.can('field:execute', v.customerId);
  if (!pickUp) requireExecute(ctx, v);
  if (v.status !== 'scheduled' && v.status !== 'requested') throw new ConflictError(`A ${v.status.replace(/_/g, ' ')} visit cannot be started`);
  const now = input?.actualStart ?? new Date();
  const values: Partial<typeof V.$inferInsert> = { status: 'in_progress', actualStart: now, updatedAt: new Date() };
  if (pickUp) values.engineerId = ctx.user.id;
  const [after] = await ctx.tx.update(V).set(values).where(eq(V.id, v.id)).returning();
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'start', customerId: v.customerId, changes: diffChanges(v as unknown as Record<string, unknown>, values as Record<string, unknown>) });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} started on site`);
  return after;
}

/**
 * Completes a visit:
 *  1. status → completed, actual times, narrative, checklist results; work
 *     minutes default to actualStart→actualEnd.
 *  2. Consumes 1 visit from the linked entitlement (`consumeEntitlement`,
 *     sourceType `field_visit`) unless `consumeEntitlement:false`.
 *  3. Records a `time_entries` row (workType onsite) for the engineer, and —
 *     when the contract carries an active `onsite_support_hours` entitlement —
 *     ALSO consumes workMinutes/60 hours from it (sourceType `time_entry`).
 *     Both consumptions are intentional: the visit entitlement counts the
 *     call-out, the hours entitlement meters on-site effort. Managers can
 *     remove either consumption from the contract's entitlement page.
 *  4. Marks the linked PM occurrence completed (copying checklist results).
 *  5. Queues the `field_visit.completed` notification.
 */
export async function completeVisit(ctx: Ctx, id: string, input: CompleteVisitInput): Promise<VisitRow> {
  const v = await loadVisit(ctx, id);
  requireExecute(ctx, v);
  if (v.status !== 'in_progress' && v.status !== 'scheduled') throw new ConflictError(`A ${v.status.replace(/_/g, ' ')} visit cannot be completed`);
  const tx = ctx.tx;
  const now = new Date();
  const actualStart = v.actualStart ?? v.scheduledStart ?? now;
  const actualEnd = input.actualEnd ?? now;
  if (actualEnd.getTime() < actualStart.getTime()) throw new ValidationError('Actual end must be after the actual start');
  const workMinutes = input.workMinutes ?? Math.max(0, Math.round((actualEnd.getTime() - actualStart.getTime()) / 60_000));
  const engineerId = v.engineerId ?? userIdOf(ctx);
  const checklist = input.checklist !== undefined ? normalizeChecklist(input.checklist) : v.checklist;
  const consume = input.consumeEntitlement ?? true;

  const values: Partial<typeof V.$inferInsert> = {
    status: 'completed',
    actualStart,
    actualEnd,
    workMinutes,
    travelMinutes: input.travelMinutes ?? v.travelMinutes ?? null,
    workSummary: input.workSummary,
    findings: input.findings ?? v.findings ?? null,
    recommendations: input.recommendations ?? v.recommendations ?? null,
    checklist: checklist as Record<string, unknown>[],
    billable: input.billable ?? v.billable,
    engineerId,
    updatedAt: now,
  };
  const meta: Record<string, unknown> = { workMinutes, consumeEntitlement: consume };

  // 2. visit entitlement
  let visitConsumptionId: string | null = v.consumptionId;
  let visitEntUnit: string | null = null;
  if (consume && v.entitlementId && !v.consumptionId) {
    const [ent] = await tx.select({ unit: schema.contractEntitlements.unit, isActive: schema.contractEntitlements.isActive }).from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, v.entitlementId)).limit(1);
    if (ent?.isActive) {
      visitEntUnit = ent.unit;
      const quantity = ent.unit === 'hours' ? Math.max(0.01, Math.round((workMinutes / 60) * 100) / 100) : 1;
      const result = await consumeEntitlement(tx, { entitlementId: v.entitlementId, quantity, sourceType: 'field_visit', sourceId: v.id, ticketId: v.ticketId, notes: `${v.number}: ${v.title}`, createdBy: userIdOf(ctx), consumedAt: actualEnd });
      visitConsumptionId = result.consumption.id;
      values.consumptionId = visitConsumptionId;
      meta.consumption = { id: visitConsumptionId, entitlementId: v.entitlementId, quantity, overage: result.overage, utilization: result.utilization };
    }
  }

  // 3. time entry + on-site hours entitlement
  if (engineerId && workMinutes > 0) {
    const [entry] = await tx
      .insert(schema.timeEntries)
      .values({ ticketId: v.ticketId, fieldVisitId: v.id, customerId: v.customerId, userId: engineerId, minutes: workMinutes, startedAt: actualStart, description: `Field visit ${v.number}: ${v.title}`, workType: 'onsite', billable: values.billable ?? false })
      .returning();
    meta.timeEntryId = entry.id;
    if (consume && v.contractId && visitEntUnit !== 'hours') {
      const hoursEnts = await tx
        .select()
        .from(schema.contractEntitlements)
        .where(and(eq(schema.contractEntitlements.contractId, v.contractId), eq(schema.contractEntitlements.isActive, true), eq(schema.contractEntitlements.unit, 'hours')));
      const keyOf = await entitlementTypeKeys(tx, hoursEnts);
      const onsite = hoursEnts.find((e) => keyOf(e) === 'onsite_support_hours');
      if (onsite) {
        const hours = Math.round((workMinutes / 60) * 100) / 100;
        if (hours > 0) {
          const r = await consumeEntitlement(tx, { entitlementId: onsite.id, quantity: hours, sourceType: 'time_entry', sourceId: entry.id, ticketId: v.ticketId, notes: `${v.number}: ${workMinutes} minutes on site`, createdBy: userIdOf(ctx), consumedAt: actualEnd });
          await tx.update(schema.timeEntries).set({ entitlementId: onsite.id, consumptionId: r.consumption.id }).where(eq(schema.timeEntries.id, entry.id));
          meta.hoursConsumption = { id: r.consumption.id, entitlementId: onsite.id, hours, overage: r.overage };
        }
      }
    }
    if (v.ticketId) await addActivity(ctx, { id: v.ticketId, customerId: v.customerId }, { type: 'time', summary: `${workMinutes} min onsite work logged (visit ${v.number})`, data: { timeEntryId: entry.id, minutes: workMinutes, fieldVisitId: v.id }, customerVisible: false });
  }

  const [after] = await tx.update(V).set(values).where(eq(V.id, v.id)).returning();

  // 4. PM occurrence
  if (v.pmOccurrenceId) {
    const [occ] = await tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, v.pmOccurrenceId)).limit(1);
    if (occ && occ.status !== 'completed' && occ.status !== 'cancelled') {
      const results = (checklist as ChecklistItem[]).map((c) => ({ item: c.item, required: !!c.required, done: !!c.done, result: c.result ?? null, notes: c.notes ?? null }));
      const occValues = { status: 'completed', completedAt: actualEnd, checklistResults: results as Record<string, unknown>[], engineerId: engineerId ?? occ.engineerId, notes: [occ.notes, `Completed via field visit ${v.number}.`].filter(Boolean).join('\n'), updatedAt: now };
      await tx.update(schema.pmOccurrences).set(occValues).where(eq(schema.pmOccurrences.id, occ.id));
      await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: `PM ${occ.plannedDate}`, action: 'complete', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, occValues as Record<string, unknown>), metadata: { visitId: v.id, visitNumber: v.number } });
      // The program's PM entitlement is consumed through the visit when they share it; otherwise consume it here.
      if (consume) {
        const [program] = await tx.select({ entitlementId: schema.pmPrograms.entitlementId, name: schema.pmPrograms.name }).from(schema.pmPrograms).where(eq(schema.pmPrograms.id, occ.programId)).limit(1);
        if (program?.entitlementId && program.entitlementId !== v.entitlementId) {
          const r = await consumeEntitlement(tx, { entitlementId: program.entitlementId, quantity: 1, sourceType: 'pm', sourceId: occ.id, ticketId: occ.ticketId ?? v.ticketId, notes: `${program.name}: ${occ.plannedDate} (visit ${v.number})`, createdBy: userIdOf(ctx), consumedAt: actualEnd });
          meta.pmConsumption = { id: r.consumption.id, entitlementId: program.entitlementId };
        }
      }
    }
  }

  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'complete', customerId: v.customerId, changes: diffChanges(v as unknown as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'checklist']), metadata: meta });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} completed: ${input.workSummary.slice(0, 200)}`, { workMinutes });
  await notifyVisit(ctx, after, 'field_visit.completed');
  return after;
}

export async function cancelVisit(ctx: Ctx, id: string, input: { reason: string }): Promise<VisitRow> {
  const v = await loadVisit(ctx, id);
  requireManage(ctx, v.customerId);
  if (v.status === 'completed') throw new ConflictError('A completed visit cannot be cancelled');
  if (v.status === 'cancelled') throw new ConflictError('The visit is already cancelled');
  const tx = ctx.tx;
  const values: Partial<typeof V.$inferInsert> = { status: 'cancelled', cancelReason: input.reason, updatedAt: new Date() };
  if (v.consumptionId) {
    await tx.delete(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.id, v.consumptionId));
    values.consumptionId = null;
  }
  const [after] = await tx.update(V).set(values).where(eq(V.id, v.id)).returning();
  // Release the PM occurrence so it can be scheduled again.
  if (v.pmOccurrenceId) {
    const [occ] = await tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, v.pmOccurrenceId)).limit(1);
    if (occ && ['scheduled', 'rescheduled', 'planned'].includes(occ.status)) {
      const occValues = { status: 'planned', fieldVisitId: null, scheduledDate: null, notes: [occ.notes, `Field visit ${v.number} cancelled: ${input.reason}`].filter(Boolean).join('\n'), updatedAt: new Date() };
      await tx.update(schema.pmOccurrences).set(occValues).where(eq(schema.pmOccurrences.id, occ.id));
      await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: `PM ${occ.plannedDate}`, action: 'visit_cancelled', customerId: occ.customerId, changes: diffChanges(occ as unknown as Record<string, unknown>, occValues as Record<string, unknown>), metadata: { visitId: v.id, reason: input.reason } });
    }
  }
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'cancel', customerId: v.customerId, changes: { status: { old: v.status, new: 'cancelled' } }, metadata: { reason: input.reason, releasedConsumptionId: v.consumptionId } });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} cancelled: ${input.reason}`);
  return after;
}

export async function rescheduleVisit(ctx: Ctx, id: string, input: RescheduleVisitInput): Promise<VisitRow> {
  const v = await loadVisit(ctx, id);
  requireManage(ctx, v.customerId);
  if (v.status !== 'scheduled') throw new ConflictError('Only scheduled visits can be rescheduled');
  assertSchedule(input.scheduledStart, input.scheduledEnd);
  const values: Partial<typeof V.$inferInsert> = { scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd ?? null, updatedAt: new Date() };
  const [after] = await ctx.tx.update(V).set(values).where(eq(V.id, v.id)).returning();
  await syncOccurrenceSchedule(ctx, after);
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'reschedule', customerId: v.customerId, changes: diffChanges(v as unknown as Record<string, unknown>, values as Record<string, unknown>), metadata: { reason: input.reason, previousStart: v.scheduledStart?.toISOString() ?? null } });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} rescheduled to ${input.scheduledStart.toISOString()}: ${input.reason}`);
  await notifyVisit(ctx, after, 'field_visit.scheduled');
  return after;
}

/**
 * Customer acknowledgement of the completed work. Allowed for the executing
 * engineer / field managers (recording a signature on site) and for customer
 * portal users of that customer. The portal module imports this function.
 */
export async function acknowledgeVisit(ctx: Ctx, visitId: string, input: AcknowledgeVisitInput): Promise<VisitRow> {
  const v = await loadVisit(ctx, visitId);
  if (isCustomerUser(ctx)) {
    if (ctx.user.customerId !== v.customerId || !ctx.can('portal:access', v.customerId)) throw new ForbiddenError('Missing permission: portal:access');
  } else {
    requireExecute(ctx, v);
  }
  if (v.status !== 'completed' && v.status !== 'in_progress') throw new ConflictError('Only completed (or in-progress) visits can be acknowledged');
  if (v.customerAckAt) throw new ConflictError('This visit has already been acknowledged');
  const values: Partial<typeof V.$inferInsert> = { customerAckName: input.name, customerAckTitle: input.title ?? null, customerAckNotes: input.notes ?? null, customerRating: input.rating ?? null, customerAckAt: new Date(), updatedAt: new Date() };
  const [after] = await ctx.tx.update(V).set(values).where(eq(V.id, v.id)).returning();
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'acknowledge', customerId: v.customerId, metadata: { name: input.name, title: input.title ?? null, rating: input.rating ?? null, byCustomerUser: isCustomerUser(ctx) } });
  await visitTicketActivity(ctx, after, `Field visit ${after.number} acknowledged by ${input.name}${input.rating ? ` (rating ${input.rating}/5)` : ''}`);
  return after;
}

// ---------------------------------------------------------------- parts

async function loadPart(ctx: Ctx, partId: string): Promise<{ part: PartRow; visit: VisitRow }> {
  const [part] = await ctx.tx.select().from(schema.fieldVisitParts).where(eq(schema.fieldVisitParts.id, partId)).limit(1);
  if (!part) throw new NotFoundError('Part');
  const visit = await loadVisit(ctx, part.visitId);
  return { part, visit };
}

const partView = (p: PartRow) => ({ ...p, quantity: Number(p.quantity), unitCost: p.unitCost === null ? null : Number(p.unitCost) });

export async function listParts(ctx: Ctx, visitId: string) {
  const v = await loadVisit(ctx, visitId);
  const rows = await ctx.tx.select().from(schema.fieldVisitParts).where(eq(schema.fieldVisitParts.visitId, v.id)).orderBy(asc(schema.fieldVisitParts.createdAt));
  return { items: rows.map(partView) };
}

async function assertAsset(tx: Tx, customerId: string, assetId: string | null | undefined) {
  if (!assetId) return;
  const [a] = await tx.select({ customerId: schema.assets.customerId }).from(schema.assets).where(eq(schema.assets.id, assetId)).limit(1);
  if (!a || a.customerId !== customerId) throw new ValidationError('Asset does not belong to the customer');
}

export async function addPart(ctx: Ctx, visitId: string, input: PartInput) {
  const v = await loadVisit(ctx, visitId);
  requireExecute(ctx, v);
  if (v.status === 'cancelled') throw new ConflictError('Parts cannot be added to a cancelled visit');
  await assertAsset(ctx.tx, v.customerId, input.assetId);
  const [part] = await ctx.tx
    .insert(schema.fieldVisitParts)
    .values({ visitId: v.id, customerId: v.customerId, name: input.name, partNumber: input.partNumber ?? null, serialNumber: input.serialNumber ?? null, quantity: String(input.quantity ?? 1), unitCost: input.unitCost === null || input.unitCost === undefined ? null : String(input.unitCost), assetId: input.assetId ?? null, billable: input.billable ?? false, notes: input.notes ?? null })
    .returning();
  await ctx.tx.update(V).set({ updatedAt: new Date() }).where(eq(V.id, v.id));
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'part.add', customerId: v.customerId, metadata: { partId: part.id, name: part.name, quantity: Number(part.quantity), partNumber: part.partNumber, serialNumber: part.serialNumber, assetId: part.assetId } });
  return partView(part);
}

export async function updatePart(ctx: Ctx, partId: string, patch: Partial<PartInput>) {
  const { part, visit } = await loadPart(ctx, partId);
  requireExecute(ctx, visit);
  if (patch.assetId !== undefined) await assertAsset(ctx.tx, visit.customerId, patch.assetId);
  const values: Partial<typeof schema.fieldVisitParts.$inferInsert> = {};
  for (const k of ['name', 'partNumber', 'serialNumber', 'assetId', 'billable', 'notes'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  if (patch.quantity !== undefined) values.quantity = String(patch.quantity);
  if (patch.unitCost !== undefined) values.unitCost = patch.unitCost === null ? null : String(patch.unitCost);
  const [after] = await ctx.tx.update(schema.fieldVisitParts).set(values).where(eq(schema.fieldVisitParts.id, part.id)).returning();
  await ctx.audit({ entityType: 'field_visit', entityId: visit.id, entityLabel: visit.number, action: 'part.update', customerId: visit.customerId, changes: diffChanges({ ...part, quantity: String(part.quantity), unitCost: part.unitCost === null ? null : String(part.unitCost) } as Record<string, unknown>, values as Record<string, unknown>), metadata: { partId: part.id } });
  return partView(after);
}

export async function deletePart(ctx: Ctx, partId: string) {
  const { part, visit } = await loadPart(ctx, partId);
  requireExecute(ctx, visit);
  await ctx.tx.delete(schema.fieldVisitParts).where(eq(schema.fieldVisitParts.id, part.id));
  await ctx.audit({ entityType: 'field_visit', entityId: visit.id, entityLabel: visit.number, action: 'part.delete', customerId: visit.customerId, metadata: { partId: part.id, name: part.name } });
  return { ok: true };
}

// ---------------------------------------------------------------- notes

export async function listNotes(ctx: Ctx, visitId: string): Promise<{ items: NoteRow[] }> {
  const v = await loadVisit(ctx, visitId);
  const conds = [eq(schema.fieldVisitNotes.visitId, v.id)];
  if (isCustomerUser(ctx)) conds.push(eq(schema.fieldVisitNotes.isInternal, false));
  const items = await ctx.tx.select().from(schema.fieldVisitNotes).where(and(...conds)).orderBy(asc(schema.fieldVisitNotes.createdAt));
  return { items };
}

export async function addNote(ctx: Ctx, visitId: string, input: NoteInput): Promise<NoteRow> {
  const v = await loadVisit(ctx, visitId);
  const customer = isCustomerUser(ctx);
  if (!customer) requireExecute(ctx, v);
  if (v.status === 'cancelled') throw new ConflictError('Notes cannot be added to a cancelled visit');
  const [note] = await ctx.tx
    .insert(schema.fieldVisitNotes)
    .values({ visitId: v.id, customerId: v.customerId, authorId: userIdOf(ctx), authorName: ctx.user.name, body: input.body, isInternal: customer ? false : (input.isInternal ?? false) })
    .returning();
  await ctx.tx.update(V).set({ updatedAt: new Date() }).where(eq(V.id, v.id));
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: note.isInternal ? 'note.internal' : 'note.add', customerId: v.customerId, metadata: { noteId: note.id, isInternal: note.isInternal, byCustomerUser: customer } });
  return note;
}

// ---------------------------------------------------------------- summary / workload

function startOfWeek(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

export async function visitSummary(ctx: Ctx, q: SummaryQuery) {
  const tx = ctx.tx;
  const base = visibilityConds(ctx, q.customerId);
  const range = parseRange(q.from, q.to);
  const ranged = [...base];
  if (range.from) ranged.push(gte(V.scheduledStart, range.from));
  if (range.to) ranged.push(lt(V.scheduledStart, range.to));
  const whereRanged = ranged.length ? and(...ranged) : undefined;
  const whereBase = base.length ? and(...base) : undefined;
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [byStatus, byType, completedAgg, tiles, topEngineers] = await sequential([
    () => tx.select({ status: V.status, count: countSql }).from(V).where(whereRanged).groupBy(V.status),
    () => tx.select({ typeId: V.typeId, label: visitType.label, count: countSql }).from(V).leftJoin(visitType, eq(visitType.id, V.typeId)).where(whereRanged).groupBy(V.typeId, visitType.label),
    () => tx.select({ completed: countSql, avgWorkMinutes: sql<number>`coalesce(avg(${V.workMinutes}), 0)::float`, totalWorkMinutes: sql<number>`coalesce(sum(${V.workMinutes}), 0)::int`, avgRating: sql<number | null>`avg(${V.customerRating})::float` }).from(V).where(and(...ranged, eq(V.status, 'completed'))),
    () =>
      tx
        .select({
          scheduledThisWeek: sql<number>`count(*) filter (where ${V.status} in ('scheduled','in_progress') and ${V.scheduledStart} >= ${weekStart.toISOString()}::timestamptz and ${V.scheduledStart} < ${weekEnd.toISOString()}::timestamptz)::int`,
          inProgress: sql<number>`count(*) filter (where ${V.status} = 'in_progress')::int`,
          requested: sql<number>`count(*) filter (where ${V.status} = 'requested')::int`,
          completedThisMonth: sql<number>`count(*) filter (where ${V.status} = 'completed' and coalesce(${V.actualEnd}, ${V.updatedAt}) >= ${monthStart.toISOString()}::timestamptz)::int`,
          pendingAcknowledgement: sql<number>`count(*) filter (where ${V.status} = 'completed' and ${V.customerAckAt} is null)::int`,
          overdue: sql<number>`count(*) filter (where ${V.status} = 'scheduled' and ${V.scheduledStart} < now())::int`,
        })
        .from(V)
        .where(whereBase),
    () =>
      tx
        .select({ engineerId: V.engineerId, engineerName: engineer.name, count: countSql, workMinutes: sql<number>`coalesce(sum(${V.workMinutes}), 0)::int` })
        .from(V)
        .leftJoin(engineer, eq(engineer.id, V.engineerId))
        .where(and(...ranged, eq(V.status, 'completed'), isNotNull(V.engineerId)))
        .groupBy(V.engineerId, engineer.name)
        .orderBy(desc(sql`count(*)`))
        .limit(5),
  ]);

  // Visits consumed vs entitled (visit-unit entitlements on covering contracts)
  let entitlements: { entitled: number; used: number; remaining: number; items: { id: string; name: string; contractId: string; contractNumber: string; customerId: string; customerName: string | null; quantity: number; used: number; remaining: number; pct: number; typeKey: string | null }[] } = { entitled: 0, used: 0, remaining: 0, items: [] };
  if (!isCustomerUser(ctx)) {
    const cconds = [inArray(schema.contracts.status, COVERING_STATUSES)];
    if (q.customerId) cconds.push(eq(schema.contracts.customerId, q.customerId));
    const contracts = await tx.select({ c: schema.contracts, customerName: schema.customers.name }).from(schema.contracts).leftJoin(schema.customers, eq(schema.customers.id, schema.contracts.customerId)).where(and(...cconds));
    if (contracts.length) {
      const ents = await tx.select().from(schema.contractEntitlements).where(and(inArray(schema.contractEntitlements.contractId, contracts.map((c) => c.c.id)), eq(schema.contractEntitlements.isActive, true), eq(schema.contractEntitlements.unit, 'visits')));
      if (ents.length) {
        const util = await utilizationBatch(tx, ents, new Map(contracts.map((c) => [c.c.id, c.c])));
        const keyOf = await entitlementTypeKeys(tx, ents);
        const cmap = new Map(contracts.map((c) => [c.c.id, c]));
        const items = ents.map((e) => {
          const u = util.get(e.id)!;
          const c = cmap.get(e.contractId)!;
          return { id: e.id, name: e.name, contractId: e.contractId, contractNumber: c.c.number, customerId: e.customerId, customerName: c.customerName, quantity: u.quantity, used: u.used, remaining: u.remaining, pct: u.pct, typeKey: keyOf(e) };
        });
        entitlements = { entitled: items.reduce((s, i) => s + i.quantity, 0), used: items.reduce((s, i) => s + i.used, 0), remaining: items.reduce((s, i) => s + i.remaining, 0), items: items.sort((a, b) => b.pct - a.pct).slice(0, 50) };
      }
    }
  }
  const statusMap: Record<string, number> = { requested: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const r of byStatus) statusMap[r.status] = r.count;
  return {
    range: { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
    total: byStatus.reduce((s, r) => s + r.count, 0),
    byStatus: statusMap,
    byType: byType.map((r) => ({ typeId: r.typeId, label: r.label ?? 'Unspecified', count: r.count })).sort((a, b) => b.count - a.count),
    completed: completedAgg[0]?.completed ?? 0,
    avgWorkMinutes: Math.round(completedAgg[0]?.avgWorkMinutes ?? 0),
    totalWorkMinutes: completedAgg[0]?.totalWorkMinutes ?? 0,
    avgRating: completedAgg[0]?.avgRating === null || completedAgg[0]?.avgRating === undefined ? null : Math.round(completedAgg[0].avgRating * 10) / 10,
    tiles: tiles[0] ?? { scheduledThisWeek: 0, inProgress: 0, requested: 0, completedThisMonth: 0, pendingAcknowledgement: 0, overdue: 0 },
    entitlements,
    topEngineers: topEngineers.map((r) => ({ engineerId: r.engineerId, engineerName: r.engineerName, count: r.count, workMinutes: r.workMinutes })),
  };
}

/** Visits per engineer per day (scheduled start, UTC date) for capacity planning. */
export async function engineerWorkload(ctx: Ctx, q: WorkloadQuery) {
  if (isCustomerUser(ctx)) throw new ForbiddenError();
  const conds = visibilityConds(ctx);
  const range = parseRange(q.from, q.to);
  if (!range.from || !range.to) throw new ValidationError('from and to are required');
  conds.push(gte(V.scheduledStart, range.from), lt(V.scheduledStart, range.to), ne(V.status, 'cancelled'), isNotNull(V.engineerId));
  if (q.teamId) conds.push(eq(V.teamId, q.teamId));
  const day = sql<string>`to_char(${V.scheduledStart} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await ctx.tx
    .select({ engineerId: V.engineerId, engineerName: engineer.name, date: day, count: countSql, minutes: sql<number>`coalesce(sum(extract(epoch from (${V.scheduledEnd} - ${V.scheduledStart})) / 60), 0)::int` })
    .from(V)
    .leftJoin(engineer, eq(engineer.id, V.engineerId))
    .where(and(...conds))
    .groupBy(V.engineerId, engineer.name, day)
    .orderBy(asc(engineer.name), asc(day));
  const byEngineer = new Map<string, { engineerId: string; engineerName: string | null; total: number; days: Record<string, number> }>();
  for (const r of rows) {
    const key = r.engineerId!;
    const e = byEngineer.get(key) ?? { engineerId: key, engineerName: r.engineerName, total: 0, days: {} };
    e.days[r.date] = (e.days[r.date] ?? 0) + r.count;
    e.total += r.count;
    byEngineer.set(key, e);
  }
  return { from: range.from.toISOString(), to: range.to.toISOString(), items: rows, engineers: [...byEngineer.values()] };
}

export { loadVisit, reloadVisit, requireRead, canExecute, canManage };
export type { VisitRow };
export const visitStatusOpen = (s: string) => OPEN_STATUSES.includes(s);
