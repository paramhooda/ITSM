import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { isCustomerUser, MAX_REPORT_ROWS, type ReportParams, type ReportColumn } from '../registry';

/** Runs a raw query under the caller's tenant transaction (RLS applies). */
export async function rows<T = Record<string, unknown>>(ctx: Ctx, query: SQL): Promise<T[]> {
  const res = await ctx.tx.execute(query);
  return res.rows as T[];
}

export const EMPTY = sql``;

/** `AND <col> = customer` when a customer is selected. */
export const customerCond = (customerId: string | null | undefined, col: SQL = sql`t.customer_id`) => (customerId ? sql`AND ${col} = ${customerId}::uuid` : EMPTY);

/** `AND <col> within [from, to]` (inclusive days). */
export const rangeCond = (col: SQL, from: string, to: string) => sql`AND ${col} >= ${from}::date AND ${col} < ${to}::date + interval '1 day'`;

/** SOC tickets are hidden from MSP users without soc:read; customer users see their own via RLS. */
export const socCond = (ctx: Ctx, col: SQL = sql`t.domain`) => (!isCustomerUser(ctx) && !ctx.can('soc:read') ? sql`AND ${col} <> 'soc'` : EMPTY);

export const OPEN_STATUS = sql`(SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))`;
export const openCond = (col: SQL = sql`t.status_id`) => sql`AND ${col} IN ${OPEN_STATUS}`;

export const limitSql = (n = MAX_REPORT_ROWS) => sql`LIMIT ${n}`;

export const pct = (num: number, den: number, digits = 1) => (den > 0 ? Math.round((num / den) * 10 ** digits * 100) / 10 ** digits : null);
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const round1 = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

export const col = (key: string, label: string, type?: ReportColumn['type']): ReportColumn => ({ key, label, type });

/** Reads a string[] parameter (multiselect) tolerating CSV strings. */
export function listParam(params: ReportParams, key: string): string[] {
  const v = params[key];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
export const strParam = (params: ReportParams, key: string): string | null => {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
export const boolParam = (params: ReportParams, key: string, fallback = false): boolean => {
  const v = params[key];
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === '1' || v === 1;
};
export const numParam = (params: ReportParams, key: string, fallback: number, min = 0, max = 3650): number => {
  const v = Number(params[key]);
  if (isNaN(v) || params[key] === '' || params[key] === undefined || params[key] === null) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
};

/** `AND col = ANY(uuid[])` when ids are present. */
export const inUuids = (col: SQL, ids: string[]) => (ids.length ? sql`AND ${col} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])` : EMPTY);

/** Standard ticket label joins (aliases: pr, st, cat, cu, sv, asg, tm). */
export const ticketJoins = sql`
  LEFT JOIN config_options pr ON pr.id = t.priority_id
  LEFT JOIN config_options st ON st.id = t.status_id
  LEFT JOIN config_options cat ON cat.id = t.category_id
  LEFT JOIN customers cu ON cu.id = t.customer_id
  LEFT JOIN services sv ON sv.id = t.service_id
  LEFT JOIN users asg ON asg.id = t.assignee_id
  LEFT JOIN teams tm ON tm.id = t.assigned_team_id`;

export const minutesBetween = (a: SQL, b: SQL) => sql`round((EXTRACT(EPOCH FROM (${a} - ${b})) / 60)::numeric, 1)`;

/** Bucketed count helper for charts: [{label, count}] -> chart data. */
export const chartData = (list: { label: string; count: number }[]) => list.map((r) => ({ label: r.label, count: Number(r.count) }));

export const dateRangeParam = { key: 'dateRange', label: 'Period', type: 'daterange' as const, required: true };
export const customerParam = { key: 'customerId', label: 'Customer', type: 'customer' as const };
