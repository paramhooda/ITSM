import { and, desc, eq, sql } from 'drizzle-orm';
import { KB_VISIBILITY } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ForbiddenError } from '@/core/errors';
import { isCustomerUser } from '@/core/authz';
import { countBuckets, fixedBuckets, KB_STATUS_COLORS, KB_VISIBILITY_COLORS } from '@/core/overview';
import { sequential } from '@/modules/contracts/common';
import { ARTICLE_TYPES, ARTICLE_STATUSES } from './service';

const a = schema.kbArticles;

const TYPE_LABELS: Record<string, string> = { sop: 'SOP', runbook: 'Runbook', troubleshooting: 'Troubleshooting', faq: 'FAQ', known_error: 'Known error', resolution: 'Resolution', procedure: 'Procedure' };

/**
 * GET /knowledge/overview (MSP users with kb:read / kb:manage). Archived
 * articles count towards `total` and `byStatus` only; every other breakdown
 * describes the live (draft + published) library.
 */
export async function knowledgeOverview(ctx: Ctx) {
  if (isCustomerUser(ctx.user)) throw new ForbiddenError('The knowledge overview is available to MSP users');
  if (!ctx.can('kb:read') && !ctx.can('kb:manage')) throw new ForbiddenError('Missing permission: kb:read');
  const count = sql<number>`count(*)::int`;
  const live = sql`${a.status} <> 'archived'`;
  const published = eq(a.status, 'published');
  const f = (cond: unknown) => sql<number>`count(*) filter (where ${cond as never})::int`;

  const [[totals], statusRows, typeRows, visibilityRows, categoryRows, topViewed, recentlyUpdated, knownErrorRows] = await sequential([
    () => ctx.tx
      .select({
        total: count,
        drafts: f(eq(a.status, 'draft')),
        expiringSoon30d: f(and(published, sql`${a.expiresAt} >= now() and ${a.expiresAt} < now() + interval '30 days'`)),
        expired: f(and(published, sql`${a.expiresAt} < now()`)),
        stale: f(and(published, sql`${a.updatedAt} < now() - interval '180 days'`)),
        withoutCategory: f(and(live, sql`${a.categoryId} is null`)),
        // No per-view log exists: the best available figure is the lifetime view counter summed over the live library.
        views: sql<number>`coalesce(sum(${a.viewCount}) filter (where ${live}), 0)::int`,
      })
      .from(a),
    () => ctx.tx.select({ key: a.status, count }).from(a).groupBy(a.status),
    () => ctx.tx.select({ key: a.articleType, count }).from(a).where(live).groupBy(a.articleType),
    () => ctx.tx.select({ key: a.visibility, count }).from(a).where(live).groupBy(a.visibility),
    () => ctx.tx.select({ key: a.categoryId, label: schema.kbCategories.name, count }).from(a).leftJoin(schema.kbCategories, eq(schema.kbCategories.id, a.categoryId)).where(live).groupBy(a.categoryId, schema.kbCategories.name),
    () => ctx.tx.select({ id: a.id, number: a.number, title: a.title, viewCount: a.viewCount, visibility: a.visibility }).from(a).where(published).orderBy(desc(a.viewCount), desc(a.helpfulCount), desc(a.updatedAt)).limit(10),
    () => ctx.tx.select({ id: a.id, number: a.number, title: a.title, updatedAt: a.updatedAt, status: a.status }).from(a).where(live).orderBy(desc(a.updatedAt)).limit(10),
    // Known error database: problems flagged as known errors (SOC fenced like the ticket list; RLS fences customers).
    () => ctx.tx.execute(sql`SELECT count(*) FILTER (WHERE coalesce(pd.ke_status, 'open') = 'open')::int AS open, count(*) FILTER (WHERE pd.ke_status = 'fix_in_progress')::int AS fix_in_progress, count(*) FILTER (WHERE pd.portal_visible)::int AS published
      FROM problem_details pd JOIN tickets t ON t.id = pd.ticket_id WHERE pd.is_known_error ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}`),
  ]);
  const ke = (knownErrorRows.rows[0] ?? {}) as { open?: number; fix_in_progress?: number; published?: number };

  return {
    total: totals?.total ?? 0,
    byStatus: fixedBuckets(ARTICLE_STATUSES, statusRows, { colors: KB_STATUS_COLORS }),
    byType: fixedBuckets(ARTICLE_TYPES, typeRows, { labels: TYPE_LABELS }),
    byVisibility: fixedBuckets(KB_VISIBILITY, visibilityRows, { colors: KB_VISIBILITY_COLORS }),
    byCategory: countBuckets(categoryRows, 'Uncategorised'),
    drafts: totals?.drafts ?? 0,
    expiringSoon30d: totals?.expiringSoon30d ?? 0,
    expired: totals?.expired ?? 0,
    stale: totals?.stale ?? 0,
    withoutCategory: totals?.withoutCategory ?? 0,
    viewsLast30d: totals?.views ?? 0,
    topViewed,
    recentlyUpdated: recentlyUpdated.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    knownErrors: { open: Number(ke.open ?? 0), fixInProgress: Number(ke.fix_in_progress ?? 0), published: Number(ke.published ?? 0) },
  };
}
