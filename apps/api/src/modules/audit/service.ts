import { eq, and, gte, lte, desc, sql, or, ilike, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ForbiddenError, NotFoundError } from '@/core/errors';
import { isCustomerUser } from '@/core/authz';
import type { Pagination } from '@/core/pagination';

const log = schema.auditLog;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 3660;

export interface AuditFilters extends Partial<Pagination> {
  entityType?: string;
  entityId?: string;
  userId?: string;
  customerId?: string;
  action?: string;
  source?: string;
  from?: string | Date;
  to?: string | Date;
  q?: string;
}

const SECRET_KEYS = /(password|secret|token|api[_-]?key|community|private[_-]?key|credential|hash)/i;

/** Masks secret-looking fields in a change set so they never leave the API. */
export function maskChanges(changes: Record<string, { old: unknown; new: unknown }> | null | undefined) {
  if (!changes) return {};
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(changes)) {
    out[k] = SECRET_KEYS.test(k) ? { old: v.old == null ? null : '********', new: v.new == null ? null : '********' } : v;
  }
  return out;
}

/** Resolves the time window. A `from` default keeps partition pruning effective on the monthly partitions. */
export function timeWindow(f: { from?: string | Date; to?: string | Date }) {
  const to = f.to ? new Date(f.to) : new Date(Date.now() + 60_000);
  let from = f.from ? new Date(f.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (isNaN(from.getTime())) from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) from = new Date(to.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  return { from, to: isNaN(to.getTime()) ? new Date() : to };
}

function escapeLike(s: string) {
  return s.replace(/[%_\\]/g, (m) => `\\${m}`);
}

export function buildConditions(f: AuditFilters): SQL[] {
  const { from, to } = timeWindow(f);
  const conds: SQL[] = [gte(log.occurredAt, from), lte(log.occurredAt, to)];
  if (f.entityType) conds.push(eq(log.entityType, f.entityType));
  if (f.entityId) conds.push(eq(log.entityId, f.entityId));
  if (f.userId) conds.push(eq(log.userId, f.userId));
  if (f.customerId) conds.push(eq(log.customerId, f.customerId));
  if (f.action) conds.push(f.action.endsWith('*') ? ilike(log.action, `${escapeLike(f.action.slice(0, -1))}%`) : eq(log.action, f.action));
  if (f.source) conds.push(eq(log.source, f.source));
  if (f.q && f.q.trim()) {
    const pattern = `%${escapeLike(f.q.trim())}%`;
    conds.push(or(ilike(log.entityLabel, pattern), ilike(log.action, pattern), ilike(log.userName, pattern))!);
  }
  return conds;
}

const columns = {
  id: log.id,
  occurredAt: log.occurredAt,
  userId: log.userId,
  userName: sql<string | null>`coalesce(${schema.users.name}, ${log.userName})`,
  userEmail: schema.users.email,
  customerId: log.customerId,
  customerName: schema.customers.name,
  entityType: log.entityType,
  entityId: log.entityId,
  entityLabel: log.entityLabel,
  action: log.action,
  changes: log.changes,
  source: log.source,
  ip: log.ip,
  userAgent: log.userAgent,
  requestId: log.requestId,
  metadata: log.metadata,
};

/** Global audit trail (admin:audit). Customer visibility is enforced by RLS on audit_log.customer_id. */
export async function listAudit(ctx: Ctx, f: AuditFilters) {
  ctx.require('admin:audit');
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, f.pageSize ?? 50));
  const where = and(...buildConditions(f));
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(log).where(where);
  const rows = await ctx.tx
    .select(columns)
    .from(log)
    .leftJoin(schema.users, eq(schema.users.id, log.userId))
    .leftJoin(schema.customers, eq(schema.customers.id, log.customerId))
    .where(where)
    .orderBy(desc(log.occurredAt), desc(log.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows.map((r) => ({ ...r, changes: maskChanges(r.changes) })), total: count, page, pageSize, window: timeWindow(f) };
}

/**
 * History of a single record. Any MSP user may read it (visibility of the
 * customer is enforced by RLS); portal users only for tickets of their own
 * customer and only the action timeline (no field-level data).
 */
export async function entityHistory(ctx: Ctx, entityType: string, entityId: string, opts: { limit?: number; from?: string | Date; to?: string | Date } = {}) {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 300));
  if (isCustomerUser(ctx.user)) {
    if (entityType !== 'ticket') throw new ForbiddenError();
    if (!ctx.can('portal:tickets')) throw new ForbiddenError();
    const [t] = await ctx.tx.select({ id: schema.tickets.id, customerId: schema.tickets.customerId }).from(schema.tickets).where(eq(schema.tickets.id, entityId)).limit(1);
    if (!t || t.customerId !== ctx.user.customerId) throw new NotFoundError('Ticket');
    const { from, to } = timeWindow({ from: opts.from ?? new Date(0), to: opts.to });
    const rows = await ctx.tx
      .select({ id: log.id, occurredAt: log.occurredAt, userName: sql<string | null>`coalesce(${schema.users.name}, ${log.userName})`, action: log.action, entityLabel: log.entityLabel })
      .from(log)
      .leftJoin(schema.users, eq(schema.users.id, log.userId))
      .where(and(eq(log.entityType, 'ticket'), eq(log.entityId, entityId), eq(log.customerId, t.customerId), gte(log.occurredAt, from), lte(log.occurredAt, to), sql`${log.action} not like 'work_note%' and ${log.action} not like 'internal%'`))
      .orderBy(desc(log.occurredAt))
      .limit(limit);
    return { items: rows.map((r) => ({ ...r, changes: {}, metadata: {}, source: 'ui', customerId: t.customerId, entityType: 'ticket', entityId })), restricted: true };
  }
  const { from, to } = timeWindow({ from: opts.from ?? new Date(0), to: opts.to });
  const rows = await ctx.tx
    .select(columns)
    .from(log)
    .leftJoin(schema.users, eq(schema.users.id, log.userId))
    .leftJoin(schema.customers, eq(schema.customers.id, log.customerId))
    .where(and(eq(log.entityType, entityType), eq(log.entityId, entityId), gte(log.occurredAt, from), lte(log.occurredAt, to)))
    .orderBy(desc(log.occurredAt), desc(log.id))
    .limit(limit);
  const items = rows.map((r) => ({ ...r, changes: maskChanges(r.changes) }));
  return { items, restricted: false };
}

export const CSV_COLUMNS = ['occurredAt', 'userName', 'userEmail', 'customerName', 'entityType', 'entityId', 'entityLabel', 'action', 'source', 'ip', 'requestId', 'changes'] as const;

/** Iterates the audit rows for export in fixed-size pages (keeps memory flat). */
export async function* iterateAudit(ctx: Ctx, f: AuditFilters, pageSize = 1000, maxRows = 200_000) {
  ctx.require('admin:audit');
  const where = and(...buildConditions(f));
  let offset = 0;
  while (offset < maxRows) {
    const rows = await ctx.tx
      .select(columns)
      .from(log)
      .leftJoin(schema.users, eq(schema.users.id, log.userId))
      .leftJoin(schema.customers, eq(schema.customers.id, log.customerId))
      .where(where)
      .orderBy(desc(log.occurredAt), desc(log.id))
      .limit(pageSize)
      .offset(offset);
    for (const r of rows) {
      yield {
        occurredAt: r.occurredAt.toISOString(),
        userName: r.userName ?? '',
        userEmail: r.userEmail ?? '',
        customerName: r.customerName ?? '',
        entityType: r.entityType,
        entityId: r.entityId ?? '',
        entityLabel: r.entityLabel ?? '',
        action: r.action,
        source: r.source,
        ip: r.ip ?? '',
        requestId: r.requestId ?? '',
        changes: JSON.stringify(maskChanges(r.changes)),
      };
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}

/** Counts for the admin dashboard: by action, by entity type, by day and most active users. */
export async function summary(ctx: Ctx, days = 7) {
  ctx.require('admin:audit');
  const d = Math.min(366, Math.max(1, days));
  const from = new Date(Date.now() - d * 86_400_000);
  const where = gte(log.occurredAt, from);
  const [{ count: total }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(log).where(where);
  const byAction = await ctx.tx.select({ action: log.action, count: sql<number>`count(*)::int` }).from(log).where(where).groupBy(log.action).orderBy(desc(sql`count(*)`)).limit(25);
  const byEntityType = await ctx.tx.select({ entityType: log.entityType, count: sql<number>`count(*)::int` }).from(log).where(where).groupBy(log.entityType).orderBy(desc(sql`count(*)`)).limit(25);
  const bySource = await ctx.tx.select({ source: log.source, count: sql<number>`count(*)::int` }).from(log).where(where).groupBy(log.source);
  const byDay = await ctx.tx
    .select({ day: sql<string>`to_char(date_trunc('day', ${log.occurredAt}), 'YYYY-MM-DD')`, count: sql<number>`count(*)::int` })
    .from(log)
    .where(where)
    .groupBy(sql`date_trunc('day', ${log.occurredAt})`)
    .orderBy(sql`date_trunc('day', ${log.occurredAt})`);
  const topUsers = await ctx.tx
    .select({ userId: log.userId, userName: sql<string | null>`max(coalesce(${schema.users.name}, ${log.userName}))`, count: sql<number>`count(*)::int` })
    .from(log)
    .leftJoin(schema.users, eq(schema.users.id, log.userId))
    .where(and(where, sql`${log.userId} is not null`))
    .groupBy(log.userId)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  const [{ count: failedLogins }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(log).where(and(where, sql`${log.action} in ('login.failed', 'login.locked')`));
  return { days: d, from, total, byAction, byEntityType, bySource, byDay, topUsers, failedLogins };
}
