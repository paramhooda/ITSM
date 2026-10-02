import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';

export async function unreadCount(ctx: Ctx) {
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.userId, ctx.user.id), isNull(schema.notifications.readAt)));
  return { unread: count };
}

export async function list(ctx: Ctx, page: number, pageSize: number, unreadOnly = false) {
  const conds = [eq(schema.notifications.userId, ctx.user.id)];
  if (unreadOnly) conds.push(isNull(schema.notifications.readAt));
  const where = and(...conds);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.notifications).where(where);
  const items = await ctx.tx.select().from(schema.notifications).where(where).orderBy(desc(schema.notifications.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return { items, total: count, page, pageSize };
}

export async function markRead(ctx: Ctx, ids: string[] | 'all') {
  const base = and(eq(schema.notifications.userId, ctx.user.id), isNull(schema.notifications.readAt));
  if (ids === 'all') await ctx.tx.update(schema.notifications).set({ readAt: new Date() }).where(base);
  else if (ids.length) await ctx.tx.update(schema.notifications).set({ readAt: new Date() }).where(and(base, sql`${schema.notifications.id} = ANY(${ids}::uuid[])`));
  return unreadCount(ctx);
}

export async function outboxStats(ctx: Ctx) {
  const rows = await ctx.tx.select({ status: schema.notificationOutbox.status, count: sql<number>`count(*)::int` }).from(schema.notificationOutbox).groupBy(schema.notificationOutbox.status);
  const recent = await ctx.tx
    .select({ id: schema.notificationOutbox.id, recipient: schema.notificationOutbox.recipient, subject: schema.notificationOutbox.subject, status: schema.notificationOutbox.status, attempts: schema.notificationOutbox.attempts, lastError: schema.notificationOutbox.lastError, sentAt: schema.notificationOutbox.sentAt, createdAt: schema.notificationOutbox.createdAt, event: schema.notificationOutbox.event })
    .from(schema.notificationOutbox)
    .orderBy(desc(schema.notificationOutbox.createdAt))
    .limit(100);
  return { byStatus: Object.fromEntries(rows.map((r) => [r.status, r.count])), recent };
}
