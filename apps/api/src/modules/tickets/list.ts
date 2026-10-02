import { eq, and, or, inArray, isNull, isNotNull, gte, lte, ne, sql, desc, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { countRows, searchFts } from '@/core/query';
import { slaSummariesFor, worstSla, slaStateFilterSql } from '@/modules/sla/engine';
import { TYPE_LABEL, csv, isCustomerUser, loadTicket, optionMap, toLabel } from './common';
import type { ListQuery, StatsQuery } from './schemas';
import { toDay, addDays, daysBetween } from '@/modules/reports/dates';

const T = schema.tickets;
const st = alias(schema.configOptions, 'st');
const pr = alias(schema.configOptions, 'pr');
const cat = alias(schema.configOptions, 'cat');
const assignee = alias(schema.users, 'assignee');

/** Visibility conditions shared by list/stats: customer users via RLS; SOC tickets need soc:read. */
function visibilityConds(ctx: Ctx): SQL[] {
  const conds: SQL[] = [];
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:tickets')) throw new ForbiddenError('Missing permission: portal:tickets');
    if (ctx.user.customerId) conds.push(eq(T.customerId, ctx.user.customerId));
  } else {
    ctx.require('tickets:read');
    if (!ctx.can('soc:read')) conds.push(ne(T.domain, 'soc'));
  }
  return conds;
}

const statusIdsOfCategories = (categories: string[]) =>
  inArray(T.statusId, sql`(SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN (${sql.join(categories.map((c) => sql`${c}`), sql`, `)}))`);

const OPEN_CATEGORIES = ['new', 'open', 'pending'];

function buildWhere(ctx: Ctx, q: StatsQuery): SQL | undefined {
  const conds: SQL[] = visibilityConds(ctx);
  if (q.type) conds.push(eq(T.type, q.type));
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(T.customerId, q.customerId));
  }
  if (q.siteId) conds.push(eq(T.siteId, q.siteId));
  if (q.serviceId) conds.push(eq(T.serviceId, q.serviceId));
  const statusIds = csv(q.statusId);
  if (statusIds.length) conds.push(inArray(T.statusId, statusIds));
  const cats = csv(q.statusCategory);
  if (cats.length) conds.push(statusIdsOfCategories(cats));
  if (q.open) conds.push(statusIdsOfCategories(OPEN_CATEGORIES));
  const prios = csv(q.priorityId);
  if (prios.length) conds.push(inArray(T.priorityId, prios));
  if (q.assigneeId) conds.push(eq(T.assigneeId, q.assigneeId));
  if (q.teamId) conds.push(eq(T.assignedTeamId, q.teamId));
  if (q.categoryId) conds.push(or(eq(T.categoryId, q.categoryId), eq(T.subcategoryId, q.categoryId))!);
  if (q.domain) conds.push(eq(T.domain, q.domain));
  if (q.scopeStatus) conds.push(eq(T.scopeStatus, q.scopeStatus));
  if (q.slaState === 'breached') conds.push(slaStateFilterSql.breached);
  else if (q.slaState === 'at_risk') conds.push(slaStateFilterSql.atRisk);
  else if (q.slaState === 'ok') conds.push(slaStateFilterSql.ok);
  if (q.createdFrom) conds.push(gte(T.createdAt, new Date(q.createdFrom)));
  if (q.createdTo) {
    const to = new Date(q.createdTo);
    if (q.createdTo.length <= 10) to.setUTCDate(to.getUTCDate() + 1);
    conds.push(lte(T.createdAt, to));
  }
  if (q.unassigned) conds.push(isNull(T.assigneeId));
  if (q.mine) conds.push(eq(T.assigneeId, ctx.user.id));
  if (q.watching) conds.push(sql`EXISTS (SELECT 1 FROM ticket_watchers w WHERE w.ticket_id = ${T.id} AND w.user_id = ${ctx.user.id}::uuid)`);
  if (q.isMajor !== undefined) conds.push(eq(T.isMajor, q.isMajor));
  const tags = csv(q.tags);
  if (tags.length) conds.push(sql`${T.tags} && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
  if (q.primaryCiId) conds.push(or(eq(T.primaryCiId, q.primaryCiId), sql`EXISTS (SELECT 1 FROM ticket_cis tc WHERE tc.ticket_id = ${T.id} AND tc.ci_id = ${q.primaryCiId}::uuid)`)!);
  if (q.assetId) conds.push(or(eq(T.primaryAssetId, q.assetId), sql`EXISTS (SELECT 1 FROM ticket_assets ta WHERE ta.ticket_id = ${T.id} AND ta.asset_id = ${q.assetId}::uuid)`)!);
  if (q.catalogItemId) conds.push(eq(T.catalogItemId, q.catalogItemId));
  if (q.securitySeverityId) conds.push(eq(T.securitySeverityId, q.securitySeverityId));
  if (q.requesterUserId) conds.push(eq(T.requesterUserId, q.requesterUserId));
  if (q.parentTicketId) conds.push(eq(T.parentTicketId, q.parentTicketId));
  const fts = searchFts(q.q, T.searchVector, T.number, T.title);
  if (fts) conds.push(fts);
  return conds.length ? and(...conds) : undefined;
}

export async function listTickets(ctx: Ctx, q: ListQuery) {
  const where = buildWhere(ctx, q);
  const total = await countRows(ctx.tx, sql`tickets`, where);
  const sortable: Record<string, { col: SQL; nullsLast?: boolean }> = {
    number: { col: sql`${T.number}` },
    createdAt: { col: sql`${T.createdAt}` },
    updatedAt: { col: sql`${T.updatedAt}` },
    lastActivityAt: { col: sql`${T.lastActivityAt}` },
    dueAt: { col: sql`${T.dueAt}`, nullsLast: true },
    priority: { col: sql`${pr.level}`, nullsLast: true },
    title: { col: sql`${T.title}` },
    status: { col: sql`${st.sortOrder}` },
    customer: { col: sql`${schema.customers.name}` },
  };
  const sortDef = sortable[q.sort ?? ''] ?? sortable.createdAt!;
  const order = sql`${sortDef.col} ${q.order === 'asc' ? sql`asc` : sql`desc`}${sortDef.nullsLast ? sql` NULLS LAST` : sql``}`;
  const rows = await ctx.tx
    .select({
      id: T.id,
      number: T.number,
      type: T.type,
      title: T.title,
      customerId: T.customerId,
      customerName: schema.customers.name,
      siteId: T.siteId,
      siteName: schema.sites.name,
      serviceId: T.serviceId,
      serviceName: schema.services.name,
      statusId: T.statusId,
      statusKey: st.key,
      statusLabel: st.label,
      statusColor: st.color,
      statusCategory: st.statusCategory,
      priorityId: T.priorityId,
      priorityKey: pr.key,
      priorityLabel: pr.label,
      priorityColor: pr.color,
      priorityLevel: pr.level,
      categoryId: T.categoryId,
      categoryLabel: cat.label,
      domain: T.domain,
      scopeStatus: T.scopeStatus,
      assigneeId: T.assigneeId,
      assigneeName: assignee.name,
      assignedTeamId: T.assignedTeamId,
      teamName: schema.teams.name,
      requesterUserId: T.requesterUserId,
      isMajor: T.isMajor,
      escalationLevel: T.escalationLevel,
      tags: T.tags,
      dueAt: T.dueAt,
      resolvedAt: T.resolvedAt,
      closedAt: T.closedAt,
      createdAt: T.createdAt,
      updatedAt: T.updatedAt,
      lastActivityAt: T.lastActivityAt,
      approvalStatus: T.approvalStatus,
      catalogItemId: T.catalogItemId,
      securitySeverityId: T.securitySeverityId,
    })
    .from(T)
    .leftJoin(st, eq(st.id, T.statusId))
    .leftJoin(pr, eq(pr.id, T.priorityId))
    .leftJoin(cat, eq(cat.id, T.categoryId))
    .leftJoin(schema.customers, eq(schema.customers.id, T.customerId))
    .leftJoin(schema.sites, eq(schema.sites.id, T.siteId))
    .leftJoin(schema.services, eq(schema.services.id, T.serviceId))
    .leftJoin(assignee, eq(assignee.id, T.assigneeId))
    .leftJoin(schema.teams, eq(schema.teams.id, T.assignedTeamId))
    .where(where)
    .orderBy(order, desc(T.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const slas = await slaSummariesFor(ctx.tx, rows.map((r) => r.id));
  const items = rows.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    typeLabel: TYPE_LABEL[r.type],
    title: r.title,
    customerId: r.customerId,
    customerName: r.customerName,
    siteId: r.siteId,
    siteName: r.siteName,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    status: { id: r.statusId, key: r.statusKey, label: r.statusLabel, color: r.statusColor, category: r.statusCategory },
    priority: r.priorityId ? { id: r.priorityId, key: r.priorityKey, label: r.priorityLabel, color: r.priorityColor, level: r.priorityLevel } : null,
    categoryId: r.categoryId,
    categoryLabel: r.categoryLabel,
    domain: r.domain,
    scopeStatus: r.scopeStatus,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeName,
    assignedTeamId: r.assignedTeamId,
    teamName: r.teamName,
    requesterUserId: r.requesterUserId,
    isMajor: r.isMajor,
    escalationLevel: r.escalationLevel,
    tags: r.tags,
    dueAt: r.dueAt,
    resolvedAt: r.resolvedAt,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastActivityAt: r.lastActivityAt,
    approvalStatus: r.approvalStatus,
    catalogItemId: r.catalogItemId,
    securitySeverityId: r.securitySeverityId,
    sla: worstSla(slas.get(r.id)),
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------- stats

const SERIES_DEFAULT_DAYS = 14;
const SERIES_MAX_DAYS = 90;

/** Day window of the opened/resolved series: the created range when both bounds are set and span <= 90 days, otherwise the last 14 days ending today. */
function seriesWindow(q: StatsQuery): { from: string; to: string } {
  if (q.createdFrom && q.createdTo) {
    const from = new Date(q.createdFrom);
    const to = new Date(q.createdTo);
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
      const f = toDay(from);
      const t = toDay(to);
      const span = daysBetween(f, t);
      if (span >= 0 && span <= SERIES_MAX_DAYS) return { from: f, to: t };
    }
  }
  const today = toDay(new Date());
  return { from: addDays(today, -(SERIES_DEFAULT_DAYS - 1)), to: today };
}

/**
 * Aggregates for the ticket list header/dashboard under the same filters as
 * the list. `byStatusCategory` ignores the status filters (so the category
 * chips can show every bucket) and `byType` ignores the type filter; every
 * other number is computed against the full filter set.
 */
export async function ticketStats(ctx: Ctx, q: StatsQuery) {
  const base = buildWhere(ctx, q);
  const openCond = statusIdsOfCategories(OPEN_CATEGORIES);
  const count = sql<number>`count(*)::int`;
  const byCategory = await ctx.tx
    .select({ category: st.statusCategory, count })
    .from(T)
    .leftJoin(st, eq(st.id, T.statusId))
    .where(buildWhere(ctx, { ...q, statusCategory: undefined, statusId: undefined, open: undefined }))
    .groupBy(st.statusCategory);
  const byType = await ctx.tx
    .select({ type: T.type, count })
    .from(T)
    .where(and(buildWhere(ctx, { ...q, type: undefined }), openCond))
    .groupBy(T.type);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const [agg] = await ctx.tx
    .select({
      total: count,
      open: sql<number>`count(*) FILTER (WHERE ${openCond})::int`,
      breached: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${slaStateFilterSql.breached})::int`,
      atRisk: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${slaStateFilterSql.atRisk})::int`,
      unassigned: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${isNull(T.assigneeId)})::int`,
      dueToday: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${isNotNull(T.dueAt)} AND ${T.dueAt} >= ${todayStart} AND ${T.dueAt} < ${todayEnd})::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${isNotNull(T.dueAt)} AND ${T.dueAt} < now())::int`,
      mine: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${T.assigneeId} = ${ctx.user.id}::uuid)::int`,
      major: sql<number>`count(*) FILTER (WHERE ${openCond} AND ${T.isMajor} = true)::int`,
      createdToday: sql<number>`count(*) FILTER (WHERE ${T.createdAt} >= ${todayStart})::int`,
      resolvedToday: sql<number>`count(*) FILTER (WHERE ${T.resolvedAt} >= ${todayStart})::int`,
    })
    .from(T)
    .where(base);
  const byPriority = await ctx.tx
    .select({ id: pr.id, label: pr.label, color: pr.color, level: pr.level, count })
    .from(T)
    .leftJoin(pr, eq(pr.id, T.priorityId))
    .where(and(base, openCond))
    .groupBy(pr.id, pr.label, pr.color, pr.level)
    .orderBy(sql`${pr.level} ASC NULLS LAST`, pr.label);
  const byStatus = await ctx.tx
    .select({ id: st.id, label: st.label, color: st.color, category: st.statusCategory, count })
    .from(T)
    .innerJoin(st, eq(st.id, T.statusId))
    .where(base)
    .groupBy(st.id, st.label, st.color, st.statusCategory, st.sortOrder)
    .orderBy(desc(count), st.sortOrder);
  const byTeam = await ctx.tx
    .select({ id: schema.teams.id, label: schema.teams.name, count, breached: sql<number>`count(*) FILTER (WHERE ${slaStateFilterSql.breached})::int` })
    .from(T)
    .leftJoin(schema.teams, eq(schema.teams.id, T.assignedTeamId))
    .where(and(base, openCond))
    .groupBy(schema.teams.id, schema.teams.name)
    .orderBy(desc(count), schema.teams.name)
    .limit(12);
  // Opened / resolved per day: two grouped queries over the window, zero-filled in JS so every day is present.
  const win = seriesWindow(q);
  const inWindow = (col: typeof T.createdAt | typeof T.resolvedAt) => and(base, sql`${col} >= ${win.from}::date`, sql`${col} < ${win.to}::date + interval '1 day'`);
  const openedDay = sql<string>`(${T.createdAt}::date)::text`;
  const resolvedDay = sql<string>`(${T.resolvedAt}::date)::text`;
  const opened = await ctx.tx.select({ day: openedDay, count }).from(T).where(inWindow(T.createdAt)).groupBy(openedDay);
  const resolved = await ctx.tx.select({ day: resolvedDay, count }).from(T).where(inWindow(T.resolvedAt)).groupBy(resolvedDay);
  const openedBy = new Map(opened.map((r) => [r.day, r.count]));
  const resolvedBy = new Map(resolved.map((r) => [r.day, r.count]));
  const series: { day: string; opened: number; resolved: number }[] = [];
  for (let d = win.from; d <= win.to; d = addDays(d, 1)) series.push({ day: d, opened: openedBy.get(d) ?? 0, resolved: resolvedBy.get(d) ?? 0 });
  const [pending] = isCustomerUser(ctx)
    ? [{ count: 0 }]
    : await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.approvals).where(eq(schema.approvals.status, 'pending'));
  return {
    byStatusCategory: Object.fromEntries(byCategory.map((r) => [r.category ?? 'unknown', r.count])),
    byType: Object.fromEntries(byType.map((r) => [r.type, r.count])),
    byPriority: byPriority.map((r) => ({ id: r.id, label: r.label ?? 'No priority', color: r.color, level: r.level, count: r.count })),
    byStatus: byStatus.map((r) => ({ id: r.id, label: r.label, color: r.color, category: r.category, count: r.count })),
    byTeam: byTeam.map((r) => ({ id: r.id, label: r.label ?? 'No team', count: r.count, breached: r.breached })),
    series,
    ...agg,
    pendingApprovals: pending?.count ?? 0,
  };
}

// ---------------------------------------------------------------- problem candidates

/** Recurring incidents (last 30 days) grouped by customer/category/CI without a linked problem record. */
export async function problemCandidates(ctx: Ctx, opts: { customerId?: string; days?: number; minCount?: number } = {}) {
  if (isCustomerUser(ctx)) throw new ForbiddenError();
  ctx.require('tickets:read');
  const days = opts.days ?? 30;
  const minCount = opts.minCount ?? 3;
  const conds: SQL[] = [sql`t.type = 'incident'`, sql`t.created_at >= now() - make_interval(days => ${days})`];
  if (opts.customerId) {
    ctx.requireCustomer(opts.customerId);
    conds.push(sql`t.customer_id = ${opts.customerId}::uuid`);
  }
  if (!ctx.can('soc:read')) conds.push(sql`t.domain <> 'soc'`);
  conds.push(sql`NOT EXISTS (SELECT 1 FROM ticket_links l JOIN tickets p ON p.id = l.target_ticket_id WHERE l.source_ticket_id = t.id AND p.type = 'problem')`);
  conds.push(sql`NOT EXISTS (SELECT 1 FROM ticket_links l JOIN tickets p ON p.id = l.source_ticket_id WHERE l.target_ticket_id = t.id AND p.type = 'problem')`);
  const res = await ctx.tx.execute(sql`
    SELECT t.customer_id AS "customerId", c.name AS "customerName", t.category_id AS "categoryId", co.label AS "categoryLabel",
           t.primary_ci_id AS "primaryCiId", ci.name AS "ciName",
           count(*)::int AS "count",
           (array_agg(t.number ORDER BY t.created_at DESC))[1:5] AS "sampleNumbers",
           (array_agg(t.id ORDER BY t.created_at DESC))[1:5] AS "sampleIds",
           max(t.created_at) AS "lastAt", min(t.created_at) AS "firstAt"
    FROM tickets t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN config_options co ON co.id = t.category_id
    LEFT JOIN cis ci ON ci.id = t.primary_ci_id
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY t.customer_id, c.name, t.category_id, co.label, t.primary_ci_id, ci.name
    HAVING count(*) >= ${minCount}
    ORDER BY count(*) DESC, max(t.created_at) DESC
    LIMIT 100`);
  return { items: res.rows as { customerId: string; customerName: string; categoryId: string | null; categoryLabel: string | null; primaryCiId: string | null; ciName: string | null; count: number; sampleNumbers: string[]; sampleIds: string[]; lastAt: string; firstAt: string }[], days, minCount };
}

// ---------------------------------------------------------------- similar tickets

export async function similarTickets(ctx: Ctx, id: string) {
  const t = await loadTicket(ctx, id);
  const conds: SQL[] = [sql`x.id <> ${t.id}::uuid`];
  if (isCustomerUser(ctx)) conds.push(sql`x.customer_id = ${t.customerId}::uuid`);
  else if (!ctx.can('soc:read')) conds.push(sql`x.domain <> 'soc'`);
  const res = await ctx.tx.execute(sql`
    SELECT x.id, x.number, x.title, x.type, x.customer_id AS "customerId", c.name AS "customerName", x.status_id AS "statusId", x.resolution_notes AS "resolutionNotes", x.resolved_at AS "resolvedAt", x.created_at AS "createdAt",
           (ts_rank(x.search_vector, plainto_tsquery('simple', ${t.title})) + similarity(x.title, ${t.title}) + CASE WHEN x.customer_id = ${t.customerId}::uuid THEN 0.5 ELSE 0 END) AS score
    FROM tickets x
    LEFT JOIN customers c ON c.id = x.customer_id
    WHERE ${sql.join(conds, sql` AND `)}
      AND (x.search_vector @@ plainto_tsquery('simple', ${t.title}) OR similarity(x.title, ${t.title}) > 0.25)
    ORDER BY (x.customer_id = ${t.customerId}::uuid) DESC, score DESC
    LIMIT 10`);
  const rows = res.rows as { id: string; number: string; title: string; type: TicketType; customerId: string; customerName: string | null; statusId: string; resolutionNotes: string | null; resolvedAt: Date | null; createdAt: Date; score: number }[];
  const opts = await optionMap(ctx.tx, rows.map((r) => r.statusId));
  return {
    items: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      type: r.type,
      customerId: r.customerId,
      customerName: r.customerName,
      sameCustomer: r.customerId === t.customerId,
      status: toLabel(opts.get(r.statusId)),
      resolutionNotes: r.resolvedAt ? r.resolutionNotes : null,
      resolvedAt: r.resolvedAt,
      createdAt: r.createdAt,
      score: Number(r.score),
    })),
  };
}
