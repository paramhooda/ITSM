import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError, ForbiddenError } from '@/core/errors';
import { countRows } from '@/core/query';
import { logger } from '@/core/logger';
import { getSetting } from '@/modules/config/service';
import { loadTicket, requireAction, addActivity, reloadTicket, systemCtx } from '@/modules/tickets/common';
import { decide as decideApproval } from '@/modules/tickets/approvals';
import { notifyTicketEvent } from '@/modules/tickets/notify';
import { buildImpact } from '@/modules/cmdb/graph';
import { scoreChange, parseThresholds, type RiskQuestion, type RiskResult, type RiskThresholds } from './risk';
import { findConflicts, windowOf, type Conflict, type OtherChange, type Blackout, type Candidate } from './conflicts';
import type * as S from './schemas';

/**
 * Change management: blackout windows, the risk questionnaire, standard
 * change templates, the change calendar with conflict detection, CAB
 * meetings and the window reminder. Conflicts are warnings on the ticket,
 * never a block; approval stays with the approvals module (a CAB decision
 * may decide the pending step).
 */

type TicketRow = typeof schema.tickets.$inferSelect;
const OPEN = ['new', 'open', 'pending'] as const;
const CAB_READ = ['changes:cab', 'changes:approve', 'changes:manage'] as const;
const THRESHOLDS_KEY = 'changes.risk_thresholds';

const requireAny = (ctx: Ctx, perms: readonly string[], customerId?: string | null) => {
  if (!perms.some((p) => ctx.can(p as never, customerId))) throw new ForbiddenError(`Missing permission: ${perms.join(' or ')}`);
};

// ---------------------------------------------------------------- blackout windows

export type BlackoutRow = typeof schema.changeBlackoutWindows.$inferSelect;
const blackoutView = (r: BlackoutRow, customerName: string | null = null) => ({ id: r.id, customerId: r.customerId, customerName, name: r.name, reason: r.reason, startsAt: r.startsAt, endsAt: r.endsAt, allowEmergency: r.allowEmergency, isActive: r.isActive, createdAt: r.createdAt, updatedAt: r.updatedAt });

export async function listBlackouts(ctx: Ctx, q: { customerId?: string; from?: Date; to?: Date; all?: boolean } = {}) {
  const b = schema.changeBlackoutWindows;
  const conds: SQL[] = [];
  if (!q.all) conds.push(eq(b.isActive, true));
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(or(isNull(b.customerId), eq(b.customerId, q.customerId))!);
  }
  if (q.from) conds.push(gt(b.endsAt, q.from));
  if (q.to) conds.push(lt(b.startsAt, q.to));
  const rows = await ctx.tx
    .select({ b, customerName: schema.customers.name })
    .from(b)
    .leftJoin(schema.customers, eq(schema.customers.id, b.customerId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(b.startsAt))
    .limit(500);
  return { items: rows.map((r) => blackoutView(r.b, r.customerName)) };
}

export async function createBlackout(ctx: Ctx, body: S.BlackoutBody) {
  ctx.require('admin:config');
  if (body.customerId) ctx.requireCustomer(body.customerId);
  const [row] = await ctx.tx.insert(schema.changeBlackoutWindows).values({ customerId: body.customerId ?? null, name: body.name, reason: body.reason ?? null, startsAt: body.startsAt, endsAt: body.endsAt, allowEmergency: body.allowEmergency ?? true, isActive: body.isActive ?? true, createdBy: ctx.user.id }).returning();
  await ctx.audit({ entityType: 'change_blackout', entityId: row!.id, entityLabel: row!.name, action: 'change_blackout.create', customerId: row!.customerId, metadata: { startsAt: row!.startsAt, endsAt: row!.endsAt } });
  return blackoutView(row!);
}

export async function updateBlackout(ctx: Ctx, id: string, patch: S.BlackoutPatch) {
  ctx.require('admin:config');
  const [before] = await ctx.tx.select().from(schema.changeBlackoutWindows).where(eq(schema.changeBlackoutWindows.id, id)).limit(1);
  if (!before) throw new NotFoundError('Blackout window');
  if (patch.customerId) ctx.requireCustomer(patch.customerId);
  const startsAt = patch.startsAt ?? before.startsAt;
  const endsAt = patch.endsAt ?? before.endsAt;
  if (endsAt.getTime() <= startsAt.getTime()) throw new ValidationError('The window must end after it starts');
  const set = { customerId: patch.customerId !== undefined ? patch.customerId : before.customerId, name: patch.name ?? before.name, reason: patch.reason !== undefined ? patch.reason : before.reason, startsAt, endsAt, allowEmergency: patch.allowEmergency ?? before.allowEmergency, isActive: patch.isActive ?? before.isActive, updatedAt: new Date() };
  const [row] = await ctx.tx.update(schema.changeBlackoutWindows).set(set).where(eq(schema.changeBlackoutWindows.id, id)).returning();
  await ctx.audit({ entityType: 'change_blackout', entityId: id, entityLabel: row!.name, action: 'change_blackout.update', customerId: row!.customerId });
  return blackoutView(row!);
}

export async function deleteBlackout(ctx: Ctx, id: string) {
  ctx.require('admin:config');
  const [row] = await ctx.tx.delete(schema.changeBlackoutWindows).where(eq(schema.changeBlackoutWindows.id, id)).returning();
  if (!row) throw new NotFoundError('Blackout window');
  await ctx.audit({ entityType: 'change_blackout', entityId: id, entityLabel: row.name, action: 'change_blackout.delete', customerId: row.customerId });
  return { ok: true };
}

// ---------------------------------------------------------------- risk questionnaire

const toQuestion = (r: typeof schema.changeRiskQuestions.$inferSelect): RiskQuestion & { hint: string | null; sortOrder: number; createdAt: Date; updatedAt: Date } => ({ id: r.id, key: r.key, question: r.question, hint: r.hint, weight: r.weight, options: r.options, sortOrder: r.sortOrder, isActive: r.isActive, createdAt: r.createdAt, updatedAt: r.updatedAt });

export async function listRiskQuestions(ctx: Ctx, all = false) {
  const q = schema.changeRiskQuestions;
  const rows = await ctx.tx.select().from(q).where(all ? undefined : eq(q.isActive, true)).orderBy(asc(q.sortOrder), asc(q.createdAt));
  return { items: rows.map(toQuestion) };
}

async function loadThresholds(ctx: Ctx): Promise<RiskThresholds> {
  return parseThresholds(await getSetting(ctx, THRESHOLDS_KEY, null));
}

/** The active questions and the thresholds, for the form. */
export async function riskQuestionnaire(ctx: Ctx) {
  const { items } = await listRiskQuestions(ctx);
  return { questions: items, thresholds: await loadThresholds(ctx) };
}

async function uniqueKey(tx: Tx, table: 'question' | 'template', key: string, exceptId?: string) {
  const t = table === 'question' ? schema.changeRiskQuestions : schema.changeTemplates;
  const [dup] = await tx.select({ id: t.id }).from(t).where(and(eq(t.key, key), exceptId ? sql`${t.id} <> ${exceptId}::uuid` : undefined)).limit(1);
  if (dup) throw new ValidationError(`A ${table} with the key "${key}" already exists`);
}

export async function createRiskQuestion(ctx: Ctx, body: S.RiskQuestionBody) {
  ctx.require('admin:config');
  await uniqueKey(ctx.tx, 'question', body.key);
  const [row] = await ctx.tx.insert(schema.changeRiskQuestions).values({ key: body.key, question: body.question, hint: body.hint ?? null, weight: body.weight ?? 1, options: body.options, sortOrder: body.sortOrder ?? 0, isActive: body.isActive ?? true }).returning();
  await ctx.audit({ entityType: 'change_risk_question', entityId: row!.id, entityLabel: row!.key, action: 'change_risk_question.create' });
  return toQuestion(row!);
}

export async function updateRiskQuestion(ctx: Ctx, id: string, patch: S.RiskQuestionPatch) {
  ctx.require('admin:config');
  const [before] = await ctx.tx.select().from(schema.changeRiskQuestions).where(eq(schema.changeRiskQuestions.id, id)).limit(1);
  if (!before) throw new NotFoundError('Risk question');
  if (patch.key && patch.key !== before.key) await uniqueKey(ctx.tx, 'question', patch.key, id);
  const [row] = await ctx.tx
    .update(schema.changeRiskQuestions)
    .set({ key: patch.key ?? before.key, question: patch.question ?? before.question, hint: patch.hint !== undefined ? patch.hint : before.hint, weight: patch.weight ?? before.weight, options: patch.options ?? before.options, sortOrder: patch.sortOrder ?? before.sortOrder, isActive: patch.isActive ?? before.isActive, updatedAt: new Date() })
    .where(eq(schema.changeRiskQuestions.id, id))
    .returning();
  await ctx.audit({ entityType: 'change_risk_question', entityId: id, entityLabel: row!.key, action: 'change_risk_question.update' });
  return toQuestion(row!);
}

export async function deleteRiskQuestion(ctx: Ctx, id: string) {
  ctx.require('admin:config');
  const [row] = await ctx.tx.delete(schema.changeRiskQuestions).where(eq(schema.changeRiskQuestions.id, id)).returning();
  if (!row) throw new NotFoundError('Risk question');
  await ctx.audit({ entityType: 'change_risk_question', entityId: id, entityLabel: row.key, action: 'change_risk_question.delete' });
  return { ok: true };
}

async function riskOptionFor(tx: Tx, level: string) {
  const [opt] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'change_risk'), eq(schema.configOptions.key, level))).limit(1);
  return opt?.id ?? null;
}

/** Scores the answers against the active questionnaire and writes the result on the change. */
export async function assessRisk(ctx: Ctx, ticketId: string, answers: S.RiskAnswers): Promise<RiskResult & { thresholds: RiskThresholds; riskId: string | null }> {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'change') throw new ValidationError('Only changes carry a risk assessment');
  requireAction(ctx, t, 'changes:manage');
  const { items: questions } = await listRiskQuestions(ctx);
  const thresholds = await loadThresholds(ctx);
  const result = scoreChange(questions, answers, thresholds);
  const riskId = await riskOptionFor(ctx.tx, result.level);
  const now = new Date();
  await ctx.tx
    .insert(schema.changeDetails)
    .values({ ticketId: t.id, customerId: t.customerId, riskAnswers: answers, riskScore: result.score, riskLevel: result.level, riskId, updatedAt: now })
    .onConflictDoUpdate({ target: schema.changeDetails.ticketId, set: { riskAnswers: answers, riskScore: result.score, riskLevel: result.level, ...(riskId ? { riskId } : {}), updatedAt: now } });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'change.risk_assessed', customerId: t.customerId, metadata: { score: result.score, level: result.level, answered: result.answered, missing: result.missing } });
  const top = result.drivers.slice(0, 2).map((d) => `${d.question.replace(/\?$/, '')}: ${d.option}`).join('; ');
  await addActivity(ctx, t, { type: 'update', summary: `Risk assessed as ${result.level} (${result.score}/100)${top ? ` · ${top}` : ''}${result.missing.length ? ` · ${result.missing.length} unanswered` : ''}`, data: { risk: { score: result.score, level: result.level, drivers: result.drivers, missing: result.missing } }, customerVisible: false });
  return { ...result, thresholds, riskId };
}

// ---------------------------------------------------------------- templates

export type TemplateRow = typeof schema.changeTemplates.$inferSelect;
const cat = alias(schema.configOptions, 'tpl_cat');
const risk = alias(schema.configOptions, 'tpl_risk');
const templateView = (r: TemplateRow, names: { categoryLabel?: string | null; serviceName?: string | null; riskLabel?: string | null } = {}) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  changeType: r.changeType,
  categoryId: r.categoryId,
  categoryLabel: names.categoryLabel ?? null,
  serviceId: r.serviceId,
  serviceName: names.serviceName ?? null,
  riskId: r.riskId,
  riskLabel: names.riskLabel ?? null,
  titleTemplate: r.titleTemplate,
  descriptionTemplate: r.descriptionTemplate,
  justification: r.justification,
  implementationPlan: r.implementationPlan,
  testPlan: r.testPlan,
  backoutPlan: r.backoutPlan,
  communicationPlan: r.communicationPlan,
  downtimeExpectedMinutes: r.downtimeExpectedMinutes,
  skipApproval: r.skipApproval,
  customerIds: r.customerIds,
  isActive: r.isActive,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
export type TemplateView = ReturnType<typeof templateView>;

export async function listTemplates(ctx: Ctx, q: { customerId?: string; all?: boolean } = {}) {
  const tpl = schema.changeTemplates;
  const conds: SQL[] = [];
  if (!q.all) conds.push(eq(tpl.isActive, true));
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(sql`(cardinality(${tpl.customerIds}) = 0 OR ${tpl.customerIds} @> ARRAY[${q.customerId}::uuid])`);
  }
  const rows = await ctx.tx
    .select({ tpl, categoryLabel: cat.label, serviceName: schema.services.name, riskLabel: risk.label })
    .from(tpl)
    .leftJoin(cat, eq(cat.id, tpl.categoryId))
    .leftJoin(schema.services, eq(schema.services.id, tpl.serviceId))
    .leftJoin(risk, eq(risk.id, tpl.riskId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(tpl.name));
  return { items: rows.map((r) => templateView(r.tpl, r)) };
}

/** A template usable for a customer (active and offered to it), or null. */
export async function loadTemplate(tx: Tx, id: string, customerId?: string | null): Promise<TemplateRow | null> {
  const [row] = await tx.select().from(schema.changeTemplates).where(eq(schema.changeTemplates.id, id)).limit(1);
  if (!row || !row.isActive) return null;
  if (customerId && row.customerIds.length && !row.customerIds.includes(customerId)) return null;
  return row;
}

const templateValues = (b: S.TemplateBody | S.TemplatePatch, before?: TemplateRow) => ({
  key: b.key ?? before?.key ?? '',
  name: b.name ?? before?.name ?? '',
  description: b.description !== undefined ? b.description : (before?.description ?? null),
  changeType: b.changeType ?? before?.changeType ?? 'standard',
  categoryId: b.categoryId !== undefined ? b.categoryId : (before?.categoryId ?? null),
  serviceId: b.serviceId !== undefined ? b.serviceId : (before?.serviceId ?? null),
  riskId: b.riskId !== undefined ? b.riskId : (before?.riskId ?? null),
  titleTemplate: b.titleTemplate !== undefined ? b.titleTemplate : (before?.titleTemplate ?? null),
  descriptionTemplate: b.descriptionTemplate !== undefined ? b.descriptionTemplate : (before?.descriptionTemplate ?? null),
  justification: b.justification !== undefined ? b.justification : (before?.justification ?? null),
  implementationPlan: b.implementationPlan !== undefined ? b.implementationPlan : (before?.implementationPlan ?? null),
  testPlan: b.testPlan !== undefined ? b.testPlan : (before?.testPlan ?? null),
  backoutPlan: b.backoutPlan !== undefined ? b.backoutPlan : (before?.backoutPlan ?? null),
  communicationPlan: b.communicationPlan !== undefined ? b.communicationPlan : (before?.communicationPlan ?? null),
  downtimeExpectedMinutes: b.downtimeExpectedMinutes !== undefined ? b.downtimeExpectedMinutes : (before?.downtimeExpectedMinutes ?? null),
  skipApproval: b.skipApproval ?? before?.skipApproval ?? true,
  customerIds: b.customerIds ?? before?.customerIds ?? [],
  isActive: b.isActive ?? before?.isActive ?? true,
});

export async function createTemplate(ctx: Ctx, body: S.TemplateBody) {
  ctx.require('admin:config');
  await uniqueKey(ctx.tx, 'template', body.key);
  for (const cid of body.customerIds ?? []) ctx.requireCustomer(cid);
  const [row] = await ctx.tx.insert(schema.changeTemplates).values(templateValues(body)).returning();
  await ctx.audit({ entityType: 'change_template', entityId: row!.id, entityLabel: row!.name, action: 'change_template.create', metadata: { key: row!.key, skipApproval: row!.skipApproval } });
  return templateView(row!);
}

export async function updateTemplate(ctx: Ctx, id: string, patch: S.TemplatePatch) {
  ctx.require('admin:config');
  const [before] = await ctx.tx.select().from(schema.changeTemplates).where(eq(schema.changeTemplates.id, id)).limit(1);
  if (!before) throw new NotFoundError('Change template');
  if (patch.key && patch.key !== before.key) await uniqueKey(ctx.tx, 'template', patch.key, id);
  for (const cid of patch.customerIds ?? []) ctx.requireCustomer(cid);
  const [row] = await ctx.tx.update(schema.changeTemplates).set({ ...templateValues(patch, before), updatedAt: new Date() }).where(eq(schema.changeTemplates.id, id)).returning();
  await ctx.audit({ entityType: 'change_template', entityId: id, entityLabel: row!.name, action: 'change_template.update' });
  return templateView(row!);
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  ctx.require('admin:config');
  const [row] = await ctx.tx.delete(schema.changeTemplates).where(eq(schema.changeTemplates.id, id)).returning();
  if (!row) throw new NotFoundError('Change template');
  await ctx.audit({ entityType: 'change_template', entityId: id, entityLabel: row.name, action: 'change_template.delete' });
  return { ok: true };
}

// ---------------------------------------------------------------- the calendar and conflicts

const st = alias(schema.configOptions, 'chg_st');
const asg = alias(schema.users, 'chg_asg');
const windowEnd = (cd: typeof schema.changeDetails) => sql`coalesce(${cd.scheduledEnd}, ${cd.scheduledStart} + interval '1 hour')`;

export interface ChangeRow {
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  changeType: string;
  status: { key: string | null; label: string | null; color: string | null; category: string | null };
  approvalStatus: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  riskLabel: string | null;
  scheduledStart: Date;
  scheduledEnd: Date | null;
  downtimeExpectedMinutes: number | null;
  assigneeName: string | null;
  primaryCiId: string | null;
  cabMeetingId: string | null;
}

async function changeRows(tx: Tx, where: SQL): Promise<ChangeRow[]> {
  const cd = schema.changeDetails;
  const t = schema.tickets;
  const rows = await tx
    .select({
      ticketId: t.id, number: t.number, title: t.title, customerId: t.customerId, customerName: schema.customers.name, changeType: cd.changeType,
      statusKey: st.key, statusLabel: st.label, statusColor: st.color, statusCategory: st.statusCategory, approvalStatus: t.approvalStatus,
      riskLevel: cd.riskLevel, riskScore: cd.riskScore, riskLabel: risk.label, scheduledStart: cd.scheduledStart, scheduledEnd: cd.scheduledEnd, downtimeExpectedMinutes: cd.downtimeExpectedMinutes,
      assigneeName: asg.name, primaryCiId: t.primaryCiId, cabMeetingId: cd.cabMeetingId,
    })
    .from(cd)
    .innerJoin(t, eq(t.id, cd.ticketId))
    .leftJoin(st, eq(st.id, t.statusId))
    .leftJoin(risk, eq(risk.id, cd.riskId))
    .leftJoin(schema.customers, eq(schema.customers.id, t.customerId))
    .leftJoin(asg, eq(asg.id, t.assigneeId))
    .where(where)
    .orderBy(asc(cd.scheduledStart))
    .limit(1000);
  return rows
    .filter((r) => r.scheduledStart)
    .map((r) => ({ ticketId: r.ticketId, number: r.number, title: r.title, customerId: r.customerId, customerName: r.customerName, changeType: r.changeType, status: { key: r.statusKey, label: r.statusLabel, color: r.statusColor, category: r.statusCategory }, approvalStatus: r.approvalStatus, riskLevel: r.riskLevel, riskScore: r.riskScore, riskLabel: r.riskLabel, scheduledStart: r.scheduledStart!, scheduledEnd: r.scheduledEnd, downtimeExpectedMinutes: r.downtimeExpectedMinutes, assigneeName: r.assigneeName, primaryCiId: r.primaryCiId, cabMeetingId: r.cabMeetingId }));
}

/** CI ids per ticket (the primary one and the affected ones). */
async function ciSetsFor(tx: Tx, tickets: { id: string; primaryCiId: string | null }[]) {
  const sets = new Map<string, Set<string>>();
  for (const t of tickets) sets.set(t.id, new Set(t.primaryCiId ? [t.primaryCiId] : []));
  if (tickets.length) {
    const rows = await tx.select({ ticketId: schema.ticketCis.ticketId, ciId: schema.ticketCis.ciId }).from(schema.ticketCis).where(inArray(schema.ticketCis.ticketId, tickets.map((t) => t.id)));
    for (const r of rows) sets.get(r.ticketId)?.add(r.ciId);
  }
  return (id: string) => [...(sets.get(id) ?? [])];
}

/** Business service ids each CI rolls up to (itself when it is one), at most 60 CIs looked up per call. */
async function serviceSetsFor(tx: Tx, ciIds: string[]) {
  const unique = [...new Set(ciIds)].slice(0, 60);
  const map = new Map<string, string[]>();
  if (!unique.length) return map;
  const types = await tx.select({ id: schema.cis.id, typeKey: schema.ciTypes.key }).from(schema.cis).innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId)).where(inArray(schema.cis.id, unique));
  const typeOf = new Map(types.map((r) => [r.id, r.typeKey]));
  for (const id of unique) {
    const impact = await buildImpact(tx, id, 6, 150);
    const ids = new Set<string>(impact?.businessServices.map((b) => b.id) ?? []);
    if (typeOf.get(id) === 'business_service') ids.add(id);
    map.set(id, [...ids]);
  }
  return map;
}

const servicesOf = (ciIds: string[], map: Map<string, string[]>) => [...new Set(ciIds.flatMap((id) => map.get(id) ?? []))];

async function blackoutsFor(tx: Tx, from: Date, to: Date, customerId?: string | null): Promise<Blackout[]> {
  const b = schema.changeBlackoutWindows;
  const conds = [eq(b.isActive, true), lt(b.startsAt, to), gt(b.endsAt, from)];
  if (customerId) conds.push(or(isNull(b.customerId), eq(b.customerId, customerId))!);
  const rows = await tx.select().from(b).where(and(...conds));
  return rows.map((r) => ({ id: r.id, name: r.name, reason: r.reason, customerId: r.customerId, start: r.startsAt, end: r.endsAt, allowEmergency: r.allowEmergency }));
}

async function toOthers(tx: Tx, rows: ChangeRow[]): Promise<OtherChange[]> {
  const ciIdsOf = await ciSetsFor(tx, rows.map((r) => ({ id: r.ticketId, primaryCiId: r.primaryCiId })));
  const serviceMap = await serviceSetsFor(tx, rows.flatMap((r) => ciIdsOf(r.ticketId)));
  return rows.map((r) => {
    const w = windowOf(r.scheduledStart, r.scheduledEnd);
    const ciIds = ciIdsOf(r.ticketId);
    return { ticketId: r.ticketId, number: r.number, title: r.title, customerId: r.customerId, customerName: r.customerName, changeType: r.changeType, status: r.status.label, start: w.start, end: w.end, ciIds, serviceIds: servicesOf(ciIds, serviceMap) };
  });
}

/** The changes with a window inside the range (cancelled ones left out), with their conflicts, plus the blackout windows. */
export async function calendar(ctx: Ctx, q: S.CalendarQuery) {
  const cd = schema.changeDetails;
  if (q.to.getTime() <= q.from.getTime()) throw new ValidationError('The range must end after it starts');
  if (q.to.getTime() - q.from.getTime() > 120 * 86_400_000) throw new ValidationError('At most 120 days at a time');
  if (q.customerId) ctx.requireCustomer(q.customerId);
  const conds: SQL[] = [sql`${cd.scheduledStart} IS NOT NULL`, lt(cd.scheduledStart, q.to), gt(windowEnd(cd), q.from), sql`coalesce(${st.statusCategory}::text, 'open') <> 'cancelled'`];
  if (q.customerId) conds.push(eq(schema.tickets.customerId, q.customerId));
  const rows = await changeRows(ctx.tx, and(...conds)!);
  const others = await toOthers(ctx.tx, rows);
  const blackouts = q.blackouts === false ? [] : await blackoutsFor(ctx.tx, q.from, q.to, q.customerId);
  const items = rows.map((r, i) => {
    const me = others[i]!;
    const candidate: Candidate = { ticketId: r.ticketId, customerId: r.customerId, changeType: r.changeType, start: me.start, end: me.end, ciIds: me.ciIds, serviceIds: me.serviceIds };
    return { ...r, conflicts: findConflicts(candidate, others, blackouts) };
  });
  return {
    from: q.from,
    to: q.to,
    items,
    blackouts: blackouts.map((b) => ({ id: b.id, name: b.name, reason: b.reason, customerId: b.customerId, startsAt: b.start, endsAt: b.end, allowEmergency: b.allowEmergency })),
    counts: { changes: items.length, conflicts: items.filter((i) => i.conflicts.length).length, blackouts: blackouts.length },
  };
}

async function conflictsFor(tx: Tx, candidate: Omit<Candidate, 'serviceIds'>): Promise<Conflict[]> {
  const cd = schema.changeDetails;
  const conds: SQL[] = [eq(schema.tickets.customerId, candidate.customerId), sql`${cd.scheduledStart} IS NOT NULL`, lt(cd.scheduledStart, candidate.end), gt(windowEnd(cd), candidate.start), sql`coalesce(${st.statusCategory}::text, 'open') NOT IN ('cancelled', 'closed')`];
  if (candidate.ticketId) conds.push(sql`${schema.tickets.id} <> ${candidate.ticketId}::uuid`);
  const rows = await changeRows(tx, and(...conds)!);
  const others = await toOthers(tx, rows);
  const serviceMap = await serviceSetsFor(tx, candidate.ciIds);
  const blackouts = await blackoutsFor(tx, candidate.start, candidate.end, candidate.customerId);
  return findConflicts({ ...candidate, serviceIds: servicesOf(candidate.ciIds, serviceMap) }, others, blackouts);
}

/** For the form: what a window would clash with before the change exists or is saved. */
export async function previewConflicts(ctx: Ctx, input: S.ConflictPreview) {
  ctx.requireCustomer(input.customerId);
  const w = windowOf(input.scheduledStart, input.scheduledEnd);
  const ciIds = [...new Set([...(input.ciIds ?? []), ...(input.primaryCiId ? [input.primaryCiId] : [])])];
  const conflicts = await conflictsFor(ctx.tx, { ticketId: input.ticketId ?? null, customerId: input.customerId, changeType: input.changeType ?? 'normal', start: w.start, end: w.end, ciIds });
  return { window: w, conflicts };
}

/** The stored change's conflicts right now. */
export async function detectConflicts(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'change') throw new ValidationError('Only changes have a window');
  const [cd] = await ctx.tx.select().from(schema.changeDetails).where(eq(schema.changeDetails.ticketId, t.id)).limit(1);
  if (!cd?.scheduledStart) return { window: null, conflicts: [] as Conflict[] };
  const w = windowOf(cd.scheduledStart, cd.scheduledEnd);
  const ciIdsOf = await ciSetsFor(ctx.tx, [{ id: t.id, primaryCiId: t.primaryCiId }]);
  const conflicts = await conflictsFor(ctx.tx, { ticketId: t.id, customerId: t.customerId, changeType: cd.changeType, start: w.start, end: w.end, ciIds: ciIdsOf(t.id) });
  return { window: w, conflicts };
}

const fingerprintOf = (conflicts: Conflict[]) => conflicts.map((c) => `${c.kind}:${c.ticket?.id ?? c.blackout?.id ?? ''}`).sort().join('|');

/**
 * Detects the conflicts of a change and records them once as a warning
 * activity (never a block). Called after the window or the CIs change.
 */
export async function recordConflicts(ctx: Ctx, ticket: Pick<TicketRow, 'id' | 'customerId' | 'type'>): Promise<Conflict[]> {
  if (ticket.type !== 'change') return [];
  if (!(await getSetting(ctx, 'changes.conflict_warnings', true))) return [];
  let conflicts: Conflict[] = [];
  try {
    conflicts = (await detectConflicts(ctx, ticket.id)).conflicts;
  } catch (err) {
    logger.warn({ err, ticketId: ticket.id }, 'conflict detection failed');
    return [];
  }
  const fingerprint = fingerprintOf(conflicts);
  const [last] = await ctx.tx
    .select({ data: schema.ticketActivities.data })
    .from(schema.ticketActivities)
    .where(and(eq(schema.ticketActivities.ticketId, ticket.id), eq(schema.ticketActivities.activityType, 'change_conflict')))
    .orderBy(desc(schema.ticketActivities.createdAt))
    .limit(1);
  const lastFp = ((last?.data as { fingerprint?: string } | null)?.fingerprint ?? '') as string;
  if (fingerprint === lastFp) return conflicts;
  if (!conflicts.length) {
    if (lastFp) await addActivity(ctx, ticket, { type: 'change_conflict', summary: 'No scheduling conflicts for the current window', data: { conflicts: [], fingerprint: '' }, customerVisible: false });
    return conflicts;
  }
  await addActivity(ctx, ticket, { type: 'change_conflict', summary: `Scheduling conflict: ${conflicts.map((c) => c.text).join('; ')}`, data: { conflicts, fingerprint }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, action: 'change.conflict', customerId: ticket.customerId, metadata: { conflicts: conflicts.map((c) => ({ kind: c.kind, ticket: c.ticket?.number, blackout: c.blackout?.name })) } });
  return conflicts;
}

// ---------------------------------------------------------------- CAB meetings

type MeetingRow = typeof schema.cabMeetings.$inferSelect;
const chair = alias(schema.users, 'cab_chair');
const meetingView = (m: MeetingRow, extra: { chairName?: string | null; items?: number; pending?: number } = {}) => ({ id: m.id, title: m.title, scheduledAt: m.scheduledAt, chairUserId: m.chairUserId, chairName: extra.chairName ?? null, status: m.status, minutes: m.minutes, closedAt: m.closedAt, items: extra.items ?? 0, pending: extra.pending ?? 0, createdAt: m.createdAt, updatedAt: m.updatedAt });

export async function listMeetings(ctx: Ctx, q: S.CabListQuery) {
  requireAny(ctx, CAB_READ);
  const m = schema.cabMeetings;
  const conds: SQL[] = [];
  const status = q.status ?? 'upcoming';
  if (status === 'upcoming') conds.push(inArray(m.status, ['scheduled', 'in_progress']), gte(m.scheduledAt, new Date(Date.now() - 86_400_000)));
  else if (status !== 'all') conds.push(eq(m.status, status));
  if (q.q) conds.push(ilike(m.title, `%${q.q}%`));
  const where = conds.length ? and(...conds) : undefined;
  const total = await countRows(ctx.tx, sql`cab_meetings`, where);
  const items = sql<number>`(SELECT count(*)::int FROM cab_meeting_items i WHERE i.meeting_id = ${m.id})`;
  const pending = sql<number>`(SELECT count(*)::int FROM cab_meeting_items i WHERE i.meeting_id = ${m.id} AND i.decision = 'pending')`;
  const rows = await ctx.tx
    .select({ m, chairName: chair.name, items, pending })
    .from(m)
    .leftJoin(chair, eq(chair.id, m.chairUserId))
    .where(where)
    .orderBy(status === 'upcoming' ? asc(m.scheduledAt) : desc(m.scheduledAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items: rows.map((r) => meetingView(r.m, { chairName: r.chairName, items: r.items, pending: r.pending })), total, page: q.page, pageSize: q.pageSize };
}

async function loadMeeting(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.cabMeetings).where(eq(schema.cabMeetings.id, id)).limit(1);
  if (!row) throw new NotFoundError('CAB meeting');
  return row;
}

async function pendingApprovalFor(tx: Tx, ticketId: string) {
  const a = schema.approvals;
  const rows = await tx.select({ id: a.id, stepName: a.stepName, step: a.step }).from(a).where(and(eq(a.ticketId, ticketId), eq(a.status, 'pending'))).orderBy(asc(a.step));
  return rows.find((r) => /cab/i.test(r.stepName ?? '')) ?? rows[0] ?? null;
}

export async function getMeeting(ctx: Ctx, id: string) {
  requireAny(ctx, CAB_READ);
  const m = await loadMeeting(ctx, id);
  const [chairRow] = m.chairUserId ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, m.chairUserId)).limit(1) : [];
  const i = schema.cabMeetingItems;
  const t = schema.tickets;
  const cd = schema.changeDetails;
  const decider = alias(schema.users, 'cab_decider');
  const rows = await ctx.tx
    .select({
      item: i, number: t.number, title: t.title, customerId: t.customerId, customerName: schema.customers.name, changeType: cd.changeType, riskLevel: cd.riskLevel, riskScore: cd.riskScore, riskLabel: risk.label,
      scheduledStart: cd.scheduledStart, scheduledEnd: cd.scheduledEnd, statusLabel: st.label, statusColor: st.color, statusCategory: st.statusCategory, approvalStatus: t.approvalStatus, assigneeName: asg.name, deciderName: decider.name,
    })
    .from(i)
    .innerJoin(t, eq(t.id, i.ticketId))
    .leftJoin(cd, eq(cd.ticketId, t.id))
    .leftJoin(st, eq(st.id, t.statusId))
    .leftJoin(risk, eq(risk.id, cd.riskId))
    .leftJoin(schema.customers, eq(schema.customers.id, t.customerId))
    .leftJoin(asg, eq(asg.id, t.assigneeId))
    .leftJoin(decider, eq(decider.id, i.decidedBy))
    .where(eq(i.meetingId, id))
    .orderBy(asc(i.sortOrder), asc(i.createdAt));
  const items = [];
  for (const r of rows) {
    const pending = await pendingApprovalFor(ctx.tx, r.item.ticketId);
    items.push({
      id: r.item.id, ticketId: r.item.ticketId, number: r.number, title: r.title, customerId: r.customerId, customerName: r.customerName, changeType: r.changeType ?? 'normal', riskLevel: r.riskLevel, riskScore: r.riskScore, riskLabel: r.riskLabel,
      scheduledStart: r.scheduledStart, scheduledEnd: r.scheduledEnd, status: { label: r.statusLabel, color: r.statusColor, category: r.statusCategory }, approvalStatus: r.approvalStatus, assigneeName: r.assigneeName,
      decision: r.item.decision, notes: r.item.notes, decidedBy: r.item.decidedBy, decidedByName: r.deciderName, decidedAt: r.item.decidedAt, sortOrder: r.item.sortOrder,
      pendingApproval: pending ? { id: pending.id, stepName: pending.stepName, step: pending.step } : null,
    });
  }
  return { ...meetingView(m, { chairName: chairRow?.name ?? null, items: items.length, pending: items.filter((x) => x.decision === 'pending').length }), items, canDecide: ctx.can('changes:cab') };
}

async function loadChangeTicket(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'change') throw new ValidationError(`${t.number} is not a change`);
  return t;
}

const meetingLabel = (m: MeetingRow) => `${m.title} (${m.scheduledAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;

async function addItemCore(ctx: Ctx, m: MeetingRow, ticketId: string, notes: string | null, sortOrder: number) {
  const t = await loadChangeTicket(ctx, ticketId);
  const [dup] = await ctx.tx.select({ id: schema.cabMeetingItems.id }).from(schema.cabMeetingItems).where(and(eq(schema.cabMeetingItems.meetingId, m.id), eq(schema.cabMeetingItems.ticketId, t.id))).limit(1);
  if (dup) throw new ValidationError(`${t.number} is already on the agenda`);
  const [row] = await ctx.tx.insert(schema.cabMeetingItems).values({ meetingId: m.id, ticketId: t.id, customerId: t.customerId, notes, sortOrder }).returning();
  await ctx.tx.insert(schema.changeDetails).values({ ticketId: t.id, customerId: t.customerId, cabMeetingId: m.id }).onConflictDoUpdate({ target: schema.changeDetails.ticketId, set: { cabMeetingId: m.id, updatedAt: new Date() } });
  await addActivity(ctx, t, { type: 'cab', summary: `Added to the CAB agenda: ${meetingLabel(m)}`, data: { meetingId: m.id }, customerVisible: false });
  return row!;
}

export async function createMeeting(ctx: Ctx, body: S.CabMeetingBody) {
  ctx.require('changes:cab');
  const [m] = await ctx.tx.insert(schema.cabMeetings).values({ title: body.title, scheduledAt: body.scheduledAt, chairUserId: body.chairUserId ?? ctx.user.id, status: body.status ?? 'scheduled', minutes: body.minutes ?? null, createdBy: ctx.user.id }).returning();
  let order = 0;
  for (const ticketId of [...new Set(body.ticketIds ?? [])]) await addItemCore(ctx, m!, ticketId, null, order++);
  await ctx.audit({ entityType: 'cab_meeting', entityId: m!.id, entityLabel: m!.title, action: 'cab.create', metadata: { scheduledAt: m!.scheduledAt, items: order } });
  return getMeeting(ctx, m!.id);
}

export async function updateMeeting(ctx: Ctx, id: string, patch: S.CabMeetingPatch) {
  ctx.require('changes:cab');
  const before = await loadMeeting(ctx, id);
  const [m] = await ctx.tx
    .update(schema.cabMeetings)
    .set({ title: patch.title ?? before.title, scheduledAt: patch.scheduledAt ?? before.scheduledAt, chairUserId: patch.chairUserId !== undefined ? patch.chairUserId : before.chairUserId, status: patch.status ?? before.status, minutes: patch.minutes !== undefined ? patch.minutes : before.minutes, closedAt: patch.status === 'closed' && before.status !== 'closed' ? new Date() : before.closedAt, updatedAt: new Date() })
    .where(eq(schema.cabMeetings.id, id))
    .returning();
  await ctx.audit({ entityType: 'cab_meeting', entityId: id, entityLabel: m!.title, action: 'cab.update' });
  return getMeeting(ctx, id);
}

export async function addItem(ctx: Ctx, meetingId: string, body: S.CabItemBody) {
  ctx.require('changes:cab');
  const m = await loadMeeting(ctx, meetingId);
  if (m.status === 'closed' || m.status === 'cancelled') throw new ValidationError('The meeting is closed');
  const [max] = await ctx.tx.select({ n: sql<number>`coalesce(max(${schema.cabMeetingItems.sortOrder}), -1)::int` }).from(schema.cabMeetingItems).where(eq(schema.cabMeetingItems.meetingId, meetingId));
  await addItemCore(ctx, m, body.ticketId, body.notes ?? null, (max?.n ?? -1) + 1);
  return getMeeting(ctx, meetingId);
}

export async function removeItem(ctx: Ctx, meetingId: string, itemId: string) {
  ctx.require('changes:cab');
  const m = await loadMeeting(ctx, meetingId);
  const [item] = await ctx.tx.delete(schema.cabMeetingItems).where(and(eq(schema.cabMeetingItems.id, itemId), eq(schema.cabMeetingItems.meetingId, meetingId))).returning();
  if (!item) throw new NotFoundError('Agenda item');
  await ctx.tx.update(schema.changeDetails).set({ cabMeetingId: null, updatedAt: new Date() }).where(and(eq(schema.changeDetails.ticketId, item.ticketId), eq(schema.changeDetails.cabMeetingId, m.id)));
  const t = await loadTicket(ctx, item.ticketId);
  await addActivity(ctx, t, { type: 'cab', summary: `Removed from the CAB agenda: ${meetingLabel(m)}`, data: { meetingId: m.id }, customerVisible: false });
  return getMeeting(ctx, meetingId);
}

/** Records the board's decision on one item; approved and rejected also decide the ticket's pending approval step when the caller may. */
export async function decideItem(ctx: Ctx, meetingId: string, itemId: string, body: S.CabDecideBody) {
  ctx.require('changes:cab');
  const m = await loadMeeting(ctx, meetingId);
  if (m.status === 'closed' || m.status === 'cancelled') throw new ValidationError('The meeting is closed');
  const [item] = await ctx.tx.select().from(schema.cabMeetingItems).where(and(eq(schema.cabMeetingItems.id, itemId), eq(schema.cabMeetingItems.meetingId, meetingId))).limit(1);
  if (!item) throw new NotFoundError('Agenda item');
  const t = await loadChangeTicket(ctx, item.ticketId);
  const now = new Date();
  await ctx.tx.update(schema.cabMeetingItems).set({ decision: body.decision, notes: body.notes ?? null, decidedBy: ctx.user.id, decidedAt: now, updatedAt: now }).where(eq(schema.cabMeetingItems.id, itemId));
  if (m.status === 'scheduled') await ctx.tx.update(schema.cabMeetings).set({ status: 'in_progress', updatedAt: now }).where(eq(schema.cabMeetings.id, m.id));
  const verb = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : 'deferred';
  await ctx.tx.update(schema.changeDetails).set({ cabNotes: body.notes ? `${m.title}: ${verb}. ${body.notes}` : `${m.title}: ${verb}.`, updatedAt: now }).where(eq(schema.changeDetails.ticketId, t.id));
  await addActivity(ctx, t, { type: 'cab', summary: `CAB ${verb} the change at ${meetingLabel(m)}${body.notes ? `: ${body.notes}` : ''}`, data: { meetingId: m.id, decision: body.decision, notes: body.notes ?? null }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'cab.decision', customerId: t.customerId, metadata: { meetingId: m.id, decision: body.decision } });
  let approval: { applied: boolean; note: string | null } = { applied: false, note: null };
  if (body.decision !== 'deferred' && body.applyToApproval !== false) {
    const pending = await pendingApprovalFor(ctx.tx, t.id);
    if (!pending) approval = { applied: false, note: 'No approval step was pending on the change' };
    else {
      try {
        await decideApproval(ctx, t.id, pending.id, body.decision, body.notes ? `CAB: ${body.notes}` : `Decided at ${m.title}`);
        approval = { applied: true, note: `Approval step "${pending.stepName ?? pending.step}" ${verb}` };
      } catch (err) {
        if (err instanceof ForbiddenError) approval = { applied: false, note: 'You may record the decision but not decide the approval step (changes:approve)' };
        else throw err;
      }
    }
  }
  const ticket = await reloadTicket(ctx.tx, t.id);
  await notifyTicketEvent(ctx, 'change.cab_decision', ticket, { reason: verb, comment: body.notes ?? null, recipientFallback: { requester: true, assignee: true }, channels: ['in_app', 'email'] });
  return { ...(await getMeeting(ctx, meetingId)), approval };
}

export async function closeMeeting(ctx: Ctx, id: string, body: { minutes?: string | null }) {
  ctx.require('changes:cab');
  const m = await loadMeeting(ctx, id);
  const now = new Date();
  const deferred = await ctx.tx.update(schema.cabMeetingItems).set({ decision: 'deferred', decidedBy: ctx.user.id, decidedAt: now, updatedAt: now }).where(and(eq(schema.cabMeetingItems.meetingId, id), eq(schema.cabMeetingItems.decision, 'pending'))).returning({ ticketId: schema.cabMeetingItems.ticketId });
  for (const d of deferred) {
    const t = await loadTicket(ctx, d.ticketId);
    await addActivity(ctx, t, { type: 'cab', summary: `Deferred: not reached at ${meetingLabel(m)}`, data: { meetingId: m.id, decision: 'deferred' }, customerVisible: false });
  }
  await ctx.tx.update(schema.cabMeetings).set({ status: 'closed', closedAt: now, minutes: body.minutes !== undefined ? body.minutes : m.minutes, updatedAt: now }).where(eq(schema.cabMeetings.id, id));
  await ctx.audit({ entityType: 'cab_meeting', entityId: id, entityLabel: m.title, action: 'cab.close', metadata: { deferred: deferred.length } });
  return getMeeting(ctx, id);
}

// ---------------------------------------------------------------- the window reminder

/** Hourly: tells the implementer, the requester and the team that a change window opens within `changes.reminder_hours`. */
export async function remindUpcomingWindows(now = new Date()) {
  let reminded = 0;
  await withSystem(async (tx) => {
    const [setting] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'changes.reminder_hours')).limit(1);
    const hours = Math.max(1, Math.min(168, Number(setting?.value) || 24));
    const horizon = new Date(now.getTime() + hours * 3600_000);
    const cd = schema.changeDetails;
    const t = schema.tickets;
    const rows = await tx
      .select({ ticketId: cd.ticketId, scheduledStart: cd.scheduledStart })
      .from(cd)
      .innerJoin(t, eq(t.id, cd.ticketId))
      .innerJoin(st, eq(st.id, t.statusId))
      .where(and(inArray(st.statusCategory, [...OPEN]), gt(cd.scheduledStart, now), lte(cd.scheduledStart, horizon), or(isNull(cd.windowReminderAt), sql`${cd.windowReminderAt} < ${cd.scheduledStart} - make_interval(hours => ${hours})`)!))
      .limit(200);
    const ctx = systemCtx(tx, 'change-window-reminder');
    for (const r of rows) {
      const ticket = await reloadTicket(tx, r.ticketId);
      const minutes = Math.round((r.scheduledStart!.getTime() - now.getTime()) / 60_000);
      const when = minutes >= 120 ? `in ${Math.round(minutes / 60)} hours` : `in ${minutes} minutes`;
      await notifyTicketEvent(ctx, 'change.window_reminder', ticket, { reason: when, recipientFallback: { assignee: true, requester: true, team: true }, channels: ['in_app', 'email'] });
      await addActivity(ctx, ticket, { type: 'update', summary: `Window reminder sent: the change starts ${when}`, data: { scheduledStart: r.scheduledStart }, customerVisible: false });
      await tx.update(cd).set({ windowReminderAt: now }).where(eq(cd.ticketId, r.ticketId));
      reminded++;
    }
  });
  return reminded;
}
