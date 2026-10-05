import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { isCustomerUser } from '@/modules/tickets/common';
import type { GroupBy } from './schemas';

/**
 * CSAT aggregates straight from `ticket_surveys` (no rollups: the table is
 * small and indexed by customer, assignee and answered date). No permission
 * checks here: the dashboards, the reports, the review pack and the customer
 * overview call these under their own guards, and row-level security applies
 * through the transaction.
 */
export interface CsatFilter {
  customerId?: string | null;
  from: Date;
  to: Date;
  assigneeId?: string | null;
  teamId?: string | null;
  serviceId?: string | null;
  domain?: string | null;
  /** Staff without soc:read never see security tickets; the same fence applies to their surveys. */
  excludeSoc?: boolean;
  satisfiedThreshold: number;
  lowThreshold: number;
}

/** True when the caller is staff without soc:read (customer users see their own security tickets through RLS). */
export const hidesSoc = (ctx: Ctx): boolean => !isCustomerUser(ctx) && !ctx.can('soc:read');

export interface CsatSeriesPoint {
  week: string;
  responses: number;
  avg: number | null;
}

export interface CsatFigures {
  /** Surveys requested in the window. */
  sent: number;
  /** Answers given in the window. */
  responses: number;
  avg: number | null;
  satisfiedPct: number | null;
  low: number;
  /** Answered share of the surveys requested in the window. */
  responseRate: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  series: CsatSeriesPoint[];
}

export interface CsatGroup {
  key: string;
  label: string;
  sent: number;
  responses: number;
  avg: number | null;
  satisfiedPct: number | null;
  low: number;
}

export interface CsatLowest {
  id: string;
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  rating: number;
  comment: string | null;
  channel: string | null;
  answeredAt: Date;
  assigneeName: string | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const avgOf = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

const baseWhere = (f: CsatFilter): SQL => {
  const conds: SQL[] = [sql`true`];
  if (f.customerId) conds.push(sql`s.customer_id = ${f.customerId}::uuid`);
  if (f.assigneeId) conds.push(sql`s.assignee_id = ${f.assigneeId}::uuid`);
  if (f.teamId) conds.push(sql`s.assigned_team_id = ${f.teamId}::uuid`);
  if (f.serviceId) conds.push(sql`s.service_id = ${f.serviceId}::uuid`);
  if (f.domain) conds.push(sql`t.domain = ${f.domain}`);
  if (f.excludeSoc) conds.push(sql`t.domain <> 'soc'`);
  return sql.join(conds, sql` AND `);
};
const answeredIn = (f: CsatFilter) => sql`(s.status = 'answered' AND s.answered_at >= ${f.from} AND s.answered_at <= ${f.to})`;
const requestedIn = (f: CsatFilter) => sql`(s.requested_at >= ${f.from} AND s.requested_at <= ${f.to})`;
const FROM = sql`FROM ticket_surveys s JOIN tickets t ON t.id = s.ticket_id`;

async function rows<T = Row>(tx: Tx, query: SQL): Promise<T[]> {
  const res = await tx.execute(query);
  return res.rows as T[];
}

export async function csatFigures(tx: Tx, f: CsatFilter): Promise<CsatFigures> {
  const a = answeredIn(f);
  const r = requestedIn(f);
  const [agg] = await rows(tx, sql`
    SELECT count(*) FILTER (WHERE ${r})::int AS sent,
      count(*) FILTER (WHERE ${r} AND s.status = 'answered')::int AS answered_of_sent,
      count(*) FILTER (WHERE ${a})::int AS responses,
      avg(s.rating) FILTER (WHERE ${a}) AS avg,
      count(*) FILTER (WHERE ${a} AND s.rating >= ${f.satisfiedThreshold})::int AS satisfied,
      count(*) FILTER (WHERE ${a} AND s.rating <= ${f.lowThreshold})::int AS low,
      count(*) FILTER (WHERE ${a} AND s.rating = 1)::int AS r1, count(*) FILTER (WHERE ${a} AND s.rating = 2)::int AS r2, count(*) FILTER (WHERE ${a} AND s.rating = 3)::int AS r3,
      count(*) FILTER (WHERE ${a} AND s.rating = 4)::int AS r4, count(*) FILTER (WHERE ${a} AND s.rating = 5)::int AS r5
    ${FROM} WHERE ${baseWhere(f)} AND (${r} OR ${a})`);
  const series = await rows(tx, sql`
    SELECT date_trunc('week', s.answered_at)::date::text AS week, count(*)::int AS responses, avg(s.rating) AS avg
    ${FROM} WHERE ${baseWhere(f)} AND ${a} GROUP BY 1 ORDER BY 1`);
  const responses = num(agg?.responses);
  return {
    sent: num(agg?.sent),
    responses,
    avg: responses ? avgOf(agg?.avg) : null,
    satisfiedPct: pct(num(agg?.satisfied), responses),
    low: num(agg?.low),
    responseRate: pct(num(agg?.answered_of_sent), num(agg?.sent)),
    distribution: { '1': num(agg?.r1), '2': num(agg?.r2), '3': num(agg?.r3), '4': num(agg?.r4), '5': num(agg?.r5) },
    series: series.map((p) => ({ week: String(p.week), responses: num(p.responses), avg: avgOf(p.avg) })),
  };
}

const GROUP_EXPR: Record<GroupBy, { key: SQL; label: SQL; joins: SQL }> = {
  customer: { key: sql`s.customer_id::text`, label: sql`coalesce(cu.name, 'Unknown customer')`, joins: sql`LEFT JOIN customers cu ON cu.id = s.customer_id` },
  engineer: { key: sql`coalesce(s.assignee_id::text, '')`, label: sql`coalesce(u.name, 'Unassigned')`, joins: sql`LEFT JOIN users u ON u.id = s.assignee_id` },
  team: { key: sql`coalesce(s.assigned_team_id::text, '')`, label: sql`coalesce(tm.name, 'No team')`, joins: sql`LEFT JOIN teams tm ON tm.id = s.assigned_team_id` },
  service: { key: sql`coalesce(s.service_id::text, '')`, label: sql`coalesce(sv.name, 'No service')`, joins: sql`LEFT JOIN services sv ON sv.id = s.service_id` },
  priority: { key: sql`coalesce(s.priority_id::text, '')`, label: sql`coalesce(pr.label, 'No priority')`, joins: sql`LEFT JOIN config_options pr ON pr.id = s.priority_id` },
  channel: { key: sql`coalesce(s.channel, '')`, label: sql`coalesce(s.channel, 'Not answered')`, joins: sql`` },
  month: { key: sql`to_char(date_trunc('month', coalesce(s.answered_at, s.requested_at)), 'YYYY-MM')`, label: sql`to_char(date_trunc('month', coalesce(s.answered_at, s.requested_at)), 'Mon YYYY')`, joins: sql`` },
};

/** Figures per customer, engineer, team, service, priority, channel or month (at most twenty groups, busiest first; months in order). */
export async function csatGroups(tx: Tx, f: CsatFilter & { groupBy: GroupBy }, limit = 20): Promise<CsatGroup[]> {
  const g = GROUP_EXPR[f.groupBy];
  const a = answeredIn(f);
  const r = requestedIn(f);
  const order = f.groupBy === 'month' ? sql`1 ASC` : sql`responses DESC, sent DESC, label ASC`;
  const list = await rows(tx, sql`
    SELECT ${g.key} AS key, ${g.label} AS label, count(*) FILTER (WHERE ${r})::int AS sent, count(*) FILTER (WHERE ${a})::int AS responses,
      avg(s.rating) FILTER (WHERE ${a}) AS avg, count(*) FILTER (WHERE ${a} AND s.rating >= ${f.satisfiedThreshold})::int AS satisfied, count(*) FILTER (WHERE ${a} AND s.rating <= ${f.lowThreshold})::int AS low
    ${FROM} ${g.joins} WHERE ${baseWhere(f)} AND (${r} OR ${a}) GROUP BY 1, 2 ORDER BY ${order} LIMIT ${limit}`);
  return list.map((row) => {
    const responses = num(row.responses);
    return { key: String(row.key ?? ''), label: String(row.label ?? ''), sent: num(row.sent), responses, avg: responses ? avgOf(row.avg) : null, satisfiedPct: pct(num(row.satisfied), responses), low: num(row.low) };
  });
}

/** The lowest-rated answered surveys in the window (the caller drops the staff-only assignee for customers). */
export async function csatLowest(tx: Tx, f: CsatFilter, limit = 10): Promise<CsatLowest[]> {
  const list = await rows(tx, sql`
    SELECT s.id, s.ticket_id, t.number, t.title, s.customer_id, cu.name AS customer_name, s.rating, s.comment, s.channel, s.answered_at, u.name AS assignee_name
    ${FROM} LEFT JOIN customers cu ON cu.id = s.customer_id LEFT JOIN users u ON u.id = s.assignee_id
    WHERE ${baseWhere(f)} AND ${answeredIn(f)} ORDER BY s.rating ASC, s.answered_at DESC LIMIT ${limit}`);
  return list.map((r) => ({ id: String(r.id), ticketId: String(r.ticket_id), number: String(r.number), title: String(r.title), customerId: String(r.customer_id), customerName: (r.customer_name as string | null) ?? null, rating: num(r.rating), comment: (r.comment as string | null) ?? null, channel: (r.channel as string | null) ?? null, answeredAt: new Date(String(r.answered_at)), assigneeName: (r.assignee_name as string | null) ?? null }));
}

const pendingCond = (customerId: string, userId?: string | null) => sql`s.customer_id = ${customerId}::uuid AND s.status = 'pending' AND s.expires_at > now() ${userId ? sql`AND s.recipient_user_id = ${userId}::uuid` : sql``}`;

/** Surveys still waiting for an answer for a customer (optionally one recipient). */
export async function pendingSurveyCount(tx: Tx, customerId: string, userId?: string | null): Promise<number> {
  const [row] = await rows(tx, sql`SELECT count(*)::int AS n FROM ticket_surveys s WHERE ${pendingCond(customerId, userId)}`);
  return num(row?.n);
}

export interface PendingSurveyItem {
  ticketId: string;
  number: string;
  title: string;
  requestedAt: Date;
  expiresAt: Date;
}

export async function pendingSurveyItems(tx: Tx, customerId: string, userId?: string | null, limit = 5): Promise<PendingSurveyItem[]> {
  const list = await rows(tx, sql`SELECT s.ticket_id, t.number, t.title, s.requested_at, s.expires_at ${FROM} WHERE ${pendingCond(customerId, userId)} ORDER BY s.requested_at DESC LIMIT ${limit}`);
  return list.map((r) => ({ ticketId: String(r.ticket_id), number: String(r.number), title: String(r.title), requestedAt: new Date(String(r.requested_at)), expiresAt: new Date(String(r.expires_at)) }));
}
