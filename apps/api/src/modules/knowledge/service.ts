import { eq, and, or, desc, asc, sql, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { KB_VISIBILITY, DOMAINS } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { isCustomerUser } from '@/core/authz';
import { orderBy } from '@/core/query';
import type { Pagination } from '@/core/pagination';

export const ARTICLE_TYPES = ['sop', 'runbook', 'troubleshooting', 'faq', 'known_error', 'resolution', 'procedure'] as const;
export const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArticleVisibility = (typeof KB_VISIBILITY)[number];

const a = schema.kbArticles;
const authorUser = alias(schema.users, 'kb_author');
const reviewerUser = alias(schema.users, 'kb_reviewer');

/**
 * Visibility rule. MSP readers see everything their customer scope allows
 * (RLS narrows customer-specific articles; internal articles are shared rows).
 * Portal users only see published public articles and published articles
 * written for their own customer.
 */
export function visibilityCondition(ctx: Ctx): SQL | undefined {
  if (!isCustomerUser(ctx.user)) return undefined;
  const cid = ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000';
  return and(eq(a.status, 'published'), or(eq(a.visibility, 'public'), and(eq(a.visibility, 'customer'), eq(a.customerId, cid))));
}

const listColumns = {
  id: a.id,
  number: a.number,
  title: a.title,
  summary: a.summary,
  categoryId: a.categoryId,
  categoryName: schema.kbCategories.name,
  articleType: a.articleType,
  domain: a.domain,
  visibility: a.visibility,
  customerId: a.customerId,
  customerName: schema.customers.name,
  serviceId: a.serviceId,
  serviceName: schema.services.name,
  ciTypeKey: a.ciTypeKey,
  status: a.status,
  version: a.version,
  authorId: a.authorId,
  authorName: authorUser.name,
  publishedAt: a.publishedAt,
  reviewedAt: a.reviewedAt,
  expiresAt: a.expiresAt,
  tags: a.tags,
  viewCount: a.viewCount,
  helpfulCount: a.helpfulCount,
  notHelpfulCount: a.notHelpfulCount,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
};

export interface ArticleFilters extends Pagination {
  q?: string;
  categoryId?: string;
  articleType?: string;
  visibility?: string;
  customerId?: string;
  serviceId?: string;
  status?: string;
  domain?: string;
  tag?: string;
  authorId?: string;
  ciTypeKey?: string;
  updatedFrom?: string;
  updatedTo?: string;
  expiring?: boolean;
  needsReview?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

function searchCondition(q: string | undefined) {
  if (!q || !q.trim()) return undefined;
  const term = q.trim();
  return or(sql`${a.searchVector} @@ websearch_to_tsquery('simple', ${term})`, sql`similarity(${a.title}, ${term}) > 0.25`, sql`${a.number} ILIKE ${term + '%'}`);
}

export async function listArticles(ctx: Ctx, f: ArticleFilters) {
  const conds: (SQL | undefined)[] = [visibilityCondition(ctx), searchCondition(f.q)];
  if (f.categoryId) conds.push(eq(a.categoryId, f.categoryId));
  if (f.articleType) conds.push(eq(a.articleType, f.articleType));
  if (f.visibility) conds.push(eq(a.visibility, f.visibility));
  if (f.customerId) conds.push(eq(a.customerId, f.customerId));
  if (f.serviceId) conds.push(eq(a.serviceId, f.serviceId));
  if (f.status) conds.push(eq(a.status, f.status));
  if (f.domain) conds.push(eq(a.domain, f.domain as (typeof DOMAINS)[number]));
  if (f.tag) conds.push(sql`${f.tag} = ANY(${a.tags})`);
  if (f.authorId) conds.push(eq(a.authorId, f.authorId));
  if (f.ciTypeKey) conds.push(eq(a.ciTypeKey, f.ciTypeKey));
  if (f.updatedFrom) conds.push(sql`${a.updatedAt} >= ${f.updatedFrom}::date`);
  if (f.updatedTo) conds.push(sql`${a.updatedAt} < ${f.updatedTo}::date + interval '1 day'`);
  if (f.expiring) conds.push(sql`${a.expiresAt} IS NOT NULL AND ${a.expiresAt} <= now() + interval '30 days'`);
  if (f.needsReview) conds.push(and(eq(a.status, 'published'), sql`coalesce(${a.reviewedAt}, ${a.publishedAt}, ${a.updatedAt}) < now() - interval '12 months'`)!);
  const where = and(...conds.filter((c): c is SQL => !!c));
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(a).where(where);
  const term = f.q?.trim();
  const relevance = term ? sql`(ts_rank_cd(${a.searchVector}, websearch_to_tsquery('simple', ${term})) + similarity(${a.title}, ${term}))` : undefined;
  const sortable = { updatedAt: a.updatedAt, title: a.title, viewCount: a.viewCount, createdAt: a.createdAt, publishedAt: a.publishedAt, number: a.number, ...(relevance ? { relevance } : {}) };
  const order = orderBy(sortable, f.sort ?? (relevance ? 'relevance' : 'updatedAt'), f.order ?? 'desc', a.updatedAt);
  const items = await ctx.tx
    .select(listColumns)
    .from(a)
    .leftJoin(schema.kbCategories, eq(schema.kbCategories.id, a.categoryId))
    .leftJoin(schema.customers, eq(schema.customers.id, a.customerId))
    .leftJoin(schema.services, eq(schema.services.id, a.serviceId))
    .leftJoin(authorUser, eq(authorUser.id, a.authorId))
    .where(where)
    .orderBy(order, desc(a.updatedAt))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: count, page: f.page, pageSize: f.pageSize };
}

// ---------------------------------------------------------------- categories

export async function listCategories(ctx: Ctx) {
  const cats = await ctx.tx.select().from(schema.kbCategories).orderBy(asc(schema.kbCategories.sortOrder), asc(schema.kbCategories.name));
  const vis = visibilityCondition(ctx);
  const counts = await ctx.tx.select({ categoryId: a.categoryId, count: sql<number>`count(*)::int` }).from(a).where(vis ? vis : sql`${a.status} <> 'archived'`).groupBy(a.categoryId);
  const byCat = new Map(counts.map((c) => [c.categoryId, c.count]));
  return { items: cats.map((c) => ({ ...c, articleCount: byCat.get(c.id) ?? 0 })), uncategorized: byCat.get(null) ?? 0 };
}

export interface CategoryInput {
  key: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  domain?: (typeof DOMAINS)[number];
  sortOrder?: number;
}

export async function createCategory(ctx: Ctx, input: CategoryInput) {
  ctx.require('kb:manage');
  if (input.parentId) {
    const [parent] = await ctx.tx.select({ id: schema.kbCategories.id }).from(schema.kbCategories).where(eq(schema.kbCategories.id, input.parentId)).limit(1);
    if (!parent) throw new ValidationError('Parent category not found');
  }
  const [row] = await ctx.tx.insert(schema.kbCategories).values({ key: input.key, name: input.name, description: input.description ?? null, parentId: input.parentId ?? null, domain: input.domain ?? 'general', sortOrder: input.sortOrder ?? 0 }).returning();
  await ctx.audit({ entityType: 'kb_category', entityId: row.id, entityLabel: row.name, action: 'create' });
  return row;
}

export async function updateCategory(ctx: Ctx, id: string, patch: Partial<CategoryInput>) {
  ctx.require('kb:manage');
  const [before] = await ctx.tx.select().from(schema.kbCategories).where(eq(schema.kbCategories.id, id)).limit(1);
  if (!before) throw new NotFoundError('Category');
  if (patch.parentId === id) throw new ValidationError('A category cannot be its own parent');
  const values: Partial<typeof schema.kbCategories.$inferInsert> = { updatedAt: new Date() };
  if (patch.key !== undefined) values.key = patch.key;
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.parentId !== undefined) values.parentId = patch.parentId;
  if (patch.domain !== undefined) values.domain = patch.domain;
  if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
  const [after] = await ctx.tx.update(schema.kbCategories).set(values).where(eq(schema.kbCategories.id, id)).returning();
  await ctx.audit({ entityType: 'kb_category', entityId: id, entityLabel: after.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>) });
  return after;
}

export async function deleteCategory(ctx: Ctx, id: string) {
  ctx.require('kb:manage');
  const [row] = await ctx.tx.select().from(schema.kbCategories).where(eq(schema.kbCategories.id, id)).limit(1);
  if (!row) throw new NotFoundError('Category');
  const [child] = await ctx.tx.select({ id: schema.kbCategories.id }).from(schema.kbCategories).where(eq(schema.kbCategories.parentId, id)).limit(1);
  if (child) throw new ValidationError('Move or delete the sub-categories first');
  await ctx.tx.update(a).set({ categoryId: null }).where(eq(a.categoryId, id));
  await ctx.tx.delete(schema.kbCategories).where(eq(schema.kbCategories.id, id));
  await ctx.audit({ entityType: 'kb_category', entityId: id, entityLabel: row.name, action: 'delete' });
  return { deleted: true };
}

// ---------------------------------------------------------------- suggestions

export interface SuggestInput {
  q: string;
  serviceId?: string;
  ciTypeKey?: string;
  customerId?: string;
  limit?: number;
}

/** Ranked published articles for a free-text context (ticket title, alert text...). */
export async function suggest(ctx: Ctx, input: SuggestInput) {
  const term = input.q.trim();
  if (term.length < 2) return { items: [] };
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
  const vis = visibilityCondition(ctx);
  const conds: SQL[] = [
    eq(a.status, 'published'),
    or(sql`${a.searchVector} @@ websearch_to_tsquery('simple', ${term})`, sql`similarity(${a.title}, ${term}) > 0.2`)!,
    or(isNull(a.expiresAt), sql`${a.expiresAt} > now()`)!,
  ];
  if (vis) conds.push(vis);
  // Never suggest another customer's article in a given customer's context.
  if (input.customerId) conds.push(or(isNull(a.customerId), eq(a.customerId, input.customerId))!);
  const score = sql<number>`(
    ts_rank_cd(${a.searchVector}, websearch_to_tsquery('simple', ${term}))
    + similarity(${a.title}, ${term})
    + (case when lower(${a.title}) = lower(${term}) then 1.0 else 0 end)
    + (case when ${input.serviceId ?? null}::uuid is not null and ${a.serviceId} = ${input.serviceId ?? null}::uuid then 0.5 else 0 end)
    + (case when ${input.ciTypeKey ?? null}::text is not null and ${a.ciTypeKey} = ${input.ciTypeKey ?? null}::text then 0.3 else 0 end)
    + (case when ${input.customerId ?? null}::uuid is not null and ${a.customerId} = ${input.customerId ?? null}::uuid then 0.4 else 0 end)
  )`;
  const rows = await ctx.tx
    .select({ id: a.id, number: a.number, title: a.title, summary: a.summary, articleType: a.articleType, visibility: a.visibility, score })
    .from(a)
    .where(and(...conds))
    .orderBy(desc(score), desc(a.viewCount))
    .limit(limit);
  return { items: rows.map((r) => ({ ...r, score: Number(r.score) })) };
}

// ---------------------------------------------------------------- articles

export interface ArticleInput {
  title: string;
  summary?: string | null;
  body?: string;
  categoryId?: string | null;
  articleType?: string;
  domain?: (typeof DOMAINS)[number];
  visibility?: ArticleVisibility;
  customerId?: string | null;
  serviceId?: string | null;
  ciTypeKey?: string | null;
  tags?: string[];
  relatedTicketIds?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

async function validateRefs(ctx: Ctx, input: Partial<ArticleInput>) {
  if (input.categoryId) {
    const [c] = await ctx.tx.select({ id: schema.kbCategories.id }).from(schema.kbCategories).where(eq(schema.kbCategories.id, input.categoryId)).limit(1);
    if (!c) throw new ValidationError('Category not found');
  }
  if (input.serviceId) {
    const [s] = await ctx.tx.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    if (!s) throw new ValidationError('Service not found');
  }
  if (input.ciTypeKey) {
    const [t] = await ctx.tx.select({ id: schema.ciTypes.id }).from(schema.ciTypes).where(eq(schema.ciTypes.key, input.ciTypeKey)).limit(1);
    if (!t) throw new ValidationError('CI type not found');
  }
  if (input.relatedTicketIds?.length) {
    const ids = [...new Set(input.relatedTicketIds)];
    const found = await ctx.tx.select({ id: schema.tickets.id }).from(schema.tickets).where(inArray(schema.tickets.id, ids));
    if (found.length !== ids.length) throw new ValidationError('One or more related tickets were not found');
  }
  if (input.customerId) {
    ctx.requireCustomer(input.customerId);
    const [c] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).limit(1);
    if (!c) throw new ValidationError('Customer not found');
  }
}

function resolveVisibility(visibility: ArticleVisibility | undefined, customerId: string | null | undefined) {
  const v: ArticleVisibility = visibility ?? 'internal';
  if (!(KB_VISIBILITY as readonly string[]).includes(v)) throw new ValidationError('Invalid visibility');
  if (v === 'customer' && !customerId) throw new ValidationError('Customer-specific articles require a customer');
  // Public articles are shared across all portals; they cannot be bound to one customer.
  return { visibility: v, customerId: v === 'public' ? null : customerId ?? null };
}

export async function nextArticleNumber(ctx: Ctx) {
  const res = await ctx.tx.execute(sql`select nextval('kb_article_seq')::int as n`);
  const n = (res.rows as { n: number }[])[0].n;
  return `KB-${String(n).padStart(6, '0')}`;
}

export async function createArticle(ctx: Ctx, input: ArticleInput) {
  if (isCustomerUser(ctx.user)) throw new ForbiddenError();
  const { visibility, customerId } = resolveVisibility(input.visibility, input.customerId);
  ctx.require('kb:manage', customerId);
  await validateRefs(ctx, { ...input, customerId });
  if (input.articleType && !(ARTICLE_TYPES as readonly string[]).includes(input.articleType)) throw new ValidationError('Invalid article type');
  const number = await nextArticleNumber(ctx);
  const [row] = await ctx.tx
    .insert(a)
    .values({
      number,
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      body: input.body ?? '',
      categoryId: input.categoryId ?? null,
      articleType: input.articleType ?? 'procedure',
      domain: input.domain ?? 'general',
      visibility,
      customerId,
      serviceId: input.serviceId ?? null,
      ciTypeKey: input.ciTypeKey ?? null,
      tags: normalizeTags(input.tags),
      relatedTicketIds: [...new Set(input.relatedTicketIds ?? [])],
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
      status: 'draft',
      version: 1,
      authorId: ctx.user.apiKeyId ? null : ctx.user.id,
    })
    .returning();
  await ctx.audit({ entityType: 'kb_article', entityId: row.id, entityLabel: `${row.number} ${row.title}`, action: 'create', customerId, metadata: { visibility, articleType: row.articleType } });
  return getArticle(ctx, row.id, { noView: true });
}

const normalizeTags = (tags?: string[]) => [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);

async function loadVisible(ctx: Ctx, id: string) {
  const vis = visibilityCondition(ctx);
  const [row] = await ctx.tx.select().from(a).where(vis ? and(eq(a.id, id), vis) : eq(a.id, id)).limit(1);
  if (!row) throw new NotFoundError('Article');
  if (row.customerId && !ctx.canSeeCustomer(row.customerId)) throw new NotFoundError('Article');
  return row;
}

async function loadForManage(ctx: Ctx, id: string) {
  if (isCustomerUser(ctx.user)) throw new ForbiddenError();
  const row = await loadVisible(ctx, id);
  ctx.require('kb:manage', row.customerId);
  return row;
}

export async function getArticle(ctx: Ctx, id: string, opts: { noView?: boolean } = {}) {
  const row = await loadVisible(ctx, id);
  if (!opts.noView) {
    await ctx.tx.update(a).set({ viewCount: sql`${a.viewCount} + 1` }).where(eq(a.id, id));
    row.viewCount += 1;
  }
  const [meta] = await ctx.tx
    .select({ categoryName: schema.kbCategories.name, categoryKey: schema.kbCategories.key, customerName: schema.customers.name, serviceName: schema.services.name, authorName: authorUser.name, reviewerName: reviewerUser.name })
    .from(a)
    .leftJoin(schema.kbCategories, eq(schema.kbCategories.id, a.categoryId))
    .leftJoin(schema.customers, eq(schema.customers.id, a.customerId))
    .leftJoin(schema.services, eq(schema.services.id, a.serviceId))
    .leftJoin(authorUser, eq(authorUser.id, a.authorId))
    .leftJoin(reviewerUser, eq(reviewerUser.id, a.reviewerId))
    .where(eq(a.id, id))
    .limit(1);
  const versions = await ctx.tx
    .select({ version: schema.kbArticleVersions.version, changedBy: schema.kbArticleVersions.changedBy, changedByName: schema.users.name, changeNote: schema.kbArticleVersions.changeNote, createdAt: schema.kbArticleVersions.createdAt })
    .from(schema.kbArticleVersions)
    .leftJoin(schema.users, eq(schema.users.id, schema.kbArticleVersions.changedBy))
    .where(eq(schema.kbArticleVersions.articleId, id))
    .orderBy(desc(schema.kbArticleVersions.version));
  const relatedTickets = row.relatedTicketIds.length
    ? await ctx.tx
        .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, type: schema.tickets.type, status: schema.configOptions.label, statusColor: schema.configOptions.color })
        .from(schema.tickets)
        .leftJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId))
        .where(inArray(schema.tickets.id, row.relatedTicketIds))
    : [];
  const canManage = !isCustomerUser(ctx.user) && ctx.can('kb:manage', row.customerId);
  return { ...row, ...meta, versions: isCustomerUser(ctx.user) ? [] : versions, relatedTickets: isCustomerUser(ctx.user) ? [] : relatedTickets, canManage };
}

async function snapshotVersion(ctx: Ctx, row: typeof a.$inferSelect, changeNote: string | null | undefined) {
  await ctx.tx.insert(schema.kbArticleVersions).values({
    articleId: row.id,
    customerId: row.customerId,
    version: row.version,
    title: row.title,
    body: row.body,
    summary: row.summary,
    changedBy: ctx.user.apiKeyId ? null : ctx.user.id,
    changeNote: changeNote?.trim() || null,
  });
}

export async function updateArticle(ctx: Ctx, id: string, patch: Partial<ArticleInput>, changeNote?: string | null) {
  const before = await loadForManage(ctx, id);
  const values: Partial<typeof a.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title.trim();
  if (patch.summary !== undefined) values.summary = patch.summary?.trim() || null;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.categoryId !== undefined) values.categoryId = patch.categoryId;
  if (patch.articleType !== undefined) {
    if (!(ARTICLE_TYPES as readonly string[]).includes(patch.articleType)) throw new ValidationError('Invalid article type');
    values.articleType = patch.articleType;
  }
  if (patch.domain !== undefined) values.domain = patch.domain;
  if (patch.serviceId !== undefined) values.serviceId = patch.serviceId;
  if (patch.ciTypeKey !== undefined) values.ciTypeKey = patch.ciTypeKey;
  if (patch.tags !== undefined) values.tags = normalizeTags(patch.tags);
  if (patch.relatedTicketIds !== undefined) values.relatedTicketIds = [...new Set(patch.relatedTicketIds)];
  if (patch.expiresAt !== undefined) values.expiresAt = patch.expiresAt;
  if (patch.metadata !== undefined) values.metadata = patch.metadata;
  if (patch.visibility !== undefined || patch.customerId !== undefined) {
    const resolved = resolveVisibility((patch.visibility ?? before.visibility) as ArticleVisibility, patch.customerId !== undefined ? patch.customerId : before.customerId);
    if (resolved.customerId !== before.customerId) ctx.require('kb:manage', resolved.customerId);
    values.visibility = resolved.visibility;
    values.customerId = resolved.customerId;
  }
  await validateRefs(ctx, { categoryId: patch.categoryId ?? undefined, serviceId: patch.serviceId ?? undefined, ciTypeKey: patch.ciTypeKey ?? undefined, relatedTicketIds: patch.relatedTicketIds, customerId: values.customerId ?? undefined });

  const contentChanged = (values.title !== undefined && values.title !== before.title) || (values.body !== undefined && values.body !== before.body) || (values.summary !== undefined && values.summary !== before.summary);
  if (contentChanged) {
    await snapshotVersion(ctx, before, changeNote);
    values.version = before.version + 1;
  }
  await ctx.tx.update(a).set(values).where(eq(a.id, id));
  if (values.customerId !== undefined && values.customerId !== before.customerId) {
    await ctx.tx.update(schema.kbArticleVersions).set({ customerId: values.customerId }).where(eq(schema.kbArticleVersions.articleId, id));
  }
  const changes = diffChanges(before as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'searchVector', 'body']);
  if (values.body !== undefined && values.body !== before.body) changes.body = { old: `${before.body.length} chars`, new: `${values.body.length} chars` };
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${before.number} ${values.title ?? before.title}`, action: 'update', customerId: values.customerId ?? before.customerId, changes, metadata: { changeNote: changeNote ?? null, version: values.version ?? before.version } });
  return getArticle(ctx, id, { noView: true });
}

export async function publishArticle(ctx: Ctx, id: string) {
  const row = await loadForManage(ctx, id);
  if (row.status === 'published') return getArticle(ctx, id, { noView: true });
  if (!row.title.trim()) throw new ValidationError('A title is required to publish');
  const now = new Date();
  await ctx.tx.update(a).set({ status: 'published', publishedAt: now, reviewerId: ctx.user.apiKeyId ? null : ctx.user.id, reviewedAt: now, updatedAt: now }).where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${row.title}`, action: 'publish', customerId: row.customerId, changes: { status: { old: row.status, new: 'published' } } });
  return getArticle(ctx, id, { noView: true });
}

export async function archiveArticle(ctx: Ctx, id: string) {
  const row = await loadForManage(ctx, id);
  if (row.status === 'archived') return getArticle(ctx, id, { noView: true });
  await ctx.tx.update(a).set({ status: 'archived', updatedAt: new Date() }).where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${row.title}`, action: 'archive', customerId: row.customerId, changes: { status: { old: row.status, new: 'archived' } } });
  return getArticle(ctx, id, { noView: true });
}

/** Re-opens an archived article as a draft. */
export async function unarchiveArticle(ctx: Ctx, id: string) {
  const row = await loadForManage(ctx, id);
  if (row.status !== 'archived') throw new ValidationError('Only archived articles can be restored to draft');
  await ctx.tx.update(a).set({ status: 'draft', updatedAt: new Date() }).where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${row.title}`, action: 'unarchive', customerId: row.customerId, changes: { status: { old: 'archived', new: 'draft' } } });
  return getArticle(ctx, id, { noView: true });
}

export async function getVersion(ctx: Ctx, id: string, version: number) {
  if (isCustomerUser(ctx.user)) throw new ForbiddenError();
  await loadVisible(ctx, id);
  const [row] = await ctx.tx
    .select({ id: schema.kbArticleVersions.id, articleId: schema.kbArticleVersions.articleId, version: schema.kbArticleVersions.version, title: schema.kbArticleVersions.title, summary: schema.kbArticleVersions.summary, body: schema.kbArticleVersions.body, changedBy: schema.kbArticleVersions.changedBy, changedByName: schema.users.name, changeNote: schema.kbArticleVersions.changeNote, createdAt: schema.kbArticleVersions.createdAt })
    .from(schema.kbArticleVersions)
    .leftJoin(schema.users, eq(schema.users.id, schema.kbArticleVersions.changedBy))
    .where(and(eq(schema.kbArticleVersions.articleId, id), eq(schema.kbArticleVersions.version, version)))
    .limit(1);
  if (!row) throw new NotFoundError('Version');
  return row;
}

export async function restoreVersion(ctx: Ctx, id: string, version: number) {
  const row = await loadForManage(ctx, id);
  const v = await getVersion(ctx, id, version);
  await snapshotVersion(ctx, row, `Restored version ${version}`);
  await ctx.tx.update(a).set({ title: v.title, summary: v.summary, body: v.body, version: row.version + 1, updatedAt: new Date() }).where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${v.title}`, action: 'restore_version', customerId: row.customerId, metadata: { restoredVersion: version, newVersion: row.version + 1 } });
  return getArticle(ctx, id, { noView: true });
}

export async function feedback(ctx: Ctx, id: string, helpful: boolean) {
  const row = await loadVisible(ctx, id);
  await ctx.tx
    .update(a)
    .set(helpful ? { helpfulCount: sql`${a.helpfulCount} + 1` } : { notHelpfulCount: sql`${a.notHelpfulCount} + 1` })
    .where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${row.title}`, action: helpful ? 'feedback.helpful' : 'feedback.not_helpful', customerId: row.customerId });
  const [after] = await ctx.tx.select({ helpfulCount: a.helpfulCount, notHelpfulCount: a.notHelpfulCount }).from(a).where(eq(a.id, id)).limit(1);
  return after;
}

export async function deleteArticle(ctx: Ctx, id: string) {
  const row = await loadForManage(ctx, id);
  if (row.status !== 'draft') throw new ValidationError('Only draft articles can be deleted; archive published articles instead');
  await ctx.tx.delete(a).where(eq(a.id, id));
  await ctx.audit({ entityType: 'kb_article', entityId: id, entityLabel: `${row.number} ${row.title}`, action: 'delete', customerId: row.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- stats

export async function stats(ctx: Ctx) {
  if (isCustomerUser(ctx.user)) throw new ForbiddenError();
  const byStatus = await ctx.tx.select({ status: a.status, count: sql<number>`count(*)::int` }).from(a).groupBy(a.status);
  const byType = await ctx.tx.select({ articleType: a.articleType, count: sql<number>`count(*)::int` }).from(a).where(sql`${a.status} <> 'archived'`).groupBy(a.articleType);
  const byVisibility = await ctx.tx.select({ visibility: a.visibility, count: sql<number>`count(*)::int` }).from(a).where(sql`${a.status} <> 'archived'`).groupBy(a.visibility);
  const topViewed = await ctx.tx
    .select({ id: a.id, number: a.number, title: a.title, viewCount: a.viewCount, helpfulCount: a.helpfulCount, notHelpfulCount: a.notHelpfulCount, articleType: a.articleType })
    .from(a)
    .where(eq(a.status, 'published'))
    .orderBy(desc(a.viewCount), desc(a.helpfulCount))
    .limit(10);
  const staleCond = and(eq(a.status, 'published'), sql`coalesce(${a.reviewedAt}, ${a.publishedAt}, ${a.updatedAt}) < now() - interval '12 months'`);
  const [{ count: staleCount }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(a).where(staleCond);
  const stale = await ctx.tx
    .select({ id: a.id, number: a.number, title: a.title, reviewedAt: a.reviewedAt, publishedAt: a.publishedAt, authorId: a.authorId, authorName: authorUser.name })
    .from(a)
    .leftJoin(authorUser, eq(authorUser.id, a.authorId))
    .where(staleCond)
    .orderBy(asc(sql`coalesce(${a.reviewedAt}, ${a.publishedAt})`))
    .limit(20);
  const [{ count: expiringCount }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(a).where(and(eq(a.status, 'published'), sql`${a.expiresAt} is not null and ${a.expiresAt} < now() + interval '30 days'`));
  return {
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byType: Object.fromEntries(byType.map((r) => [r.articleType, r.count])),
    byVisibility: Object.fromEntries(byVisibility.map((r) => [r.visibility, r.count])),
    topViewed,
    stale: { count: staleCount, items: stale },
    expiringSoon: expiringCount,
  };
}
