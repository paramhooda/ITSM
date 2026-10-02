import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { runAs } from '../src/core/context';
import { hashPassword } from '../src/lib/crypto';
import * as kb from '../src/modules/knowledge/service';
import { postgresSearchProvider } from '../src/modules/search/postgres';

/**
 * DB-backed tests for the knowledge module. Requires the dev database env
 * (DATABASE_URL etc.) to be exported; migrations + default seed applied.
 */
const SUFFIX = Date.now().toString(36);
const meta = { requestId: `test-${SUFFIX}`, ip: '127.0.0.1', source: 'api' as const };

let admin: Principal;
let customerUser: Principal;
let customerA: string;
let customerB: string;
const createdArticleIds: string[] = [];
const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];

async function principalFor(email: string) {
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1));
  invalidatePrincipal(u.id);
  const p = await loadPrincipal(u.id);
  if (!p) throw new Error(`principal not loaded for ${email}`);
  return p;
}

beforeAll(async () => {
  admin = await principalFor('admin@msp.local');
  await withSystem(async (tx) => {
    const [a] = await tx.insert(schema.customers).values({ code: `KBT-A-${SUFFIX}`, name: `KB Test Customer A ${SUFFIX}` }).returning({ id: schema.customers.id });
    const [b] = await tx.insert(schema.customers).values({ code: `KBT-B-${SUFFIX}`, name: `KB Test Customer B ${SUFFIX}` }).returning({ id: schema.customers.id });
    customerA = a.id;
    customerB = b.id;
    createdCustomerIds.push(a.id, b.id);
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const [u] = await tx
      .insert(schema.users)
      .values({ email: `kb-customer-${SUFFIX}@test.local`, name: 'KB Customer User', userType: 'customer', customerId: customerA, passwordHash: await hashPassword('Customer@12345'), status: 'active' })
      .returning({ id: schema.users.id });
    createdUserIds.push(u.id);
    await tx.insert(schema.userRoles).values({ userId: u.id, roleId: role.id });
  });
  customerUser = await principalFor(`kb-customer-${SUFFIX}@test.local`);
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdArticleIds.length) await tx.delete(schema.kbArticles).where(inArray(schema.kbArticles.id, createdArticleIds));
    await tx.delete(schema.kbArticles).where(like(schema.kbArticles.title, `%${SUFFIX}%`));
    if (createdUserIds.length) await tx.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    if (createdCustomerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, createdCustomerIds));
  });
  await closeDb();
});

describe('knowledge articles', () => {
  let internalId: string;
  let customerAId: string;
  let customerBId: string;
  let publicId: string;

  it('creates articles with sequential KB numbers', async () => {
    const internal = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Exchange transport restart ${SUFFIX}`, summary: 'Internal runbook', body: 'Step 1', articleType: 'runbook', visibility: 'internal', tags: ['Exchange', 'email'] }));
    const forA = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Customer A VPN guide ${SUFFIX}`, body: 'Use profile A', visibility: 'customer', customerId: customerA }));
    const forB = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Customer B firewall policy ${SUFFIX}`, body: 'B only', visibility: 'customer', customerId: customerB }));
    const pub = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Reset your portal password ${SUFFIX}`, body: 'Click forgot password', visibility: 'public', articleType: 'faq' }));
    internalId = internal.id;
    customerAId = forA.id;
    customerBId = forB.id;
    publicId = pub.id;
    createdArticleIds.push(internalId, customerAId, customerBId, publicId);
    expect(internal.number).toMatch(/^KB-\d{6}$/);
    expect(internal.status).toBe('draft');
    expect(internal.version).toBe(1);
    expect(internal.tags).toEqual(['exchange', 'email']);
    expect(pub.customerId).toBeNull();
  });

  it('rejects customer visibility without a customer', async () => {
    await expect(runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `bad ${SUFFIX}`, visibility: 'customer' }))).rejects.toThrow(/require a customer/);
  });

  it('publishes articles (reviewer + timestamps)', async () => {
    for (const id of [internalId, customerAId, customerBId, publicId]) {
      const res = await runAs(admin, meta, (ctx) => kb.publishArticle(ctx, id));
      expect(res.status).toBe('published');
      expect(res.publishedAt).toBeInstanceOf(Date);
      expect(res.reviewerId).toBe(admin.id);
    }
  });

  it('admin list sees all articles', async () => {
    const res = await runAs(admin, meta, (ctx) => kb.listArticles(ctx, { page: 1, pageSize: 100, q: SUFFIX }));
    const ids = res.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([internalId, customerAId, customerBId, publicId]));
    expect(res.items.find((i) => i.id === customerAId)?.customerName).toContain('KB Test Customer A');
  });

  it('customer user sees only published public + own-customer articles', async () => {
    const res = await runAs(customerUser, meta, (ctx) => kb.listArticles(ctx, { page: 1, pageSize: 100, q: SUFFIX }));
    const ids = res.items.map((i) => i.id).sort();
    expect(ids).toEqual([customerAId, publicId].sort());
    await expect(runAs(customerUser, meta, (ctx) => kb.getArticle(ctx, internalId))).rejects.toThrow(/not found/i);
    await expect(runAs(customerUser, meta, (ctx) => kb.getArticle(ctx, customerBId))).rejects.toThrow(/not found/i);
    const own = await runAs(customerUser, meta, (ctx) => kb.getArticle(ctx, customerAId));
    expect(own.id).toBe(customerAId);
    expect(own.canManage).toBe(false);
  });

  it('customer user cannot see drafts even when public', async () => {
    const draft = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Draft public ${SUFFIX}`, visibility: 'public' }));
    createdArticleIds.push(draft.id);
    const res = await runAs(customerUser, meta, (ctx) => kb.listArticles(ctx, { page: 1, pageSize: 100, q: SUFFIX }));
    expect(res.items.map((i) => i.id)).not.toContain(draft.id);
    await expect(runAs(customerUser, meta, (ctx) => kb.createArticle(ctx, { title: 'x' }))).rejects.toThrow();
  });

  it('increments the view counter unless noView', async () => {
    const before = await runAs(admin, meta, (ctx) => kb.getArticle(ctx, publicId, { noView: true }));
    const viewed = await runAs(admin, meta, (ctx) => kb.getArticle(ctx, publicId));
    const after = await runAs(admin, meta, (ctx) => kb.getArticle(ctx, publicId, { noView: true }));
    expect(viewed.viewCount).toBe(before.viewCount + 1);
    expect(after.viewCount).toBe(before.viewCount + 1);
  });

  it('suggest ranks the exact title match first and respects customer context', async () => {
    const title = `Exchange transport restart ${SUFFIX}`;
    const res = await runAs(admin, meta, (ctx) => kb.suggest(ctx, { q: title, limit: 5 }));
    expect(res.items[0]?.id).toBe(internalId);
    expect(res.items[0].score).toBeGreaterThan(res.items[1]?.score ?? 0);
    // Customer context: B's article never suggested in A's context.
    const ctxA = await runAs(admin, meta, (ctx) => kb.suggest(ctx, { q: `${SUFFIX}`, customerId: customerA, limit: 10 }));
    expect(ctxA.items.map((i) => i.id)).not.toContain(customerBId);
    // Portal users only get what they may read.
    const portal = await runAs(customerUser, meta, (ctx) => kb.suggest(ctx, { q: `${SUFFIX}`, limit: 10 }));
    const ids = portal.items.map((i) => i.id);
    expect(ids).not.toContain(internalId);
    expect(ids).not.toContain(customerBId);
    expect(ids).toEqual(expect.arrayContaining([customerAId, publicId]));
  });

  it('edit creates a version snapshot and restore works', async () => {
    const edited = await runAs(admin, meta, (ctx) => kb.updateArticle(ctx, internalId, { body: 'Step 1\nStep 2' }, 'added step 2'));
    expect(edited.version).toBe(2);
    expect(edited.versions).toHaveLength(1);
    expect(edited.versions[0]).toMatchObject({ version: 1, changeNote: 'added step 2', changedBy: admin.id });
    const v1 = await runAs(admin, meta, (ctx) => kb.getVersion(ctx, internalId, 1));
    expect(v1.body).toBe('Step 1');
    // Non-content changes do not bump the version.
    const tagged = await runAs(admin, meta, (ctx) => kb.updateArticle(ctx, internalId, { tags: ['exchange'] }));
    expect(tagged.version).toBe(2);
    const restored = await runAs(admin, meta, (ctx) => kb.restoreVersion(ctx, internalId, 1));
    expect(restored.version).toBe(3);
    expect(restored.body).toBe('Step 1');
    expect(restored.versions.map((v) => v.version)).toEqual([2, 1]);
    const v2 = await runAs(admin, meta, (ctx) => kb.getVersion(ctx, internalId, 2));
    expect(v2.body).toBe('Step 1\nStep 2');
  });

  it('feedback increments counters for any reader', async () => {
    const r1 = await runAs(customerUser, meta, (ctx) => kb.feedback(ctx, publicId, true));
    const r2 = await runAs(admin, meta, (ctx) => kb.feedback(ctx, publicId, false));
    expect(r1.helpfulCount).toBe(1);
    expect(r2.notHelpfulCount).toBe(1);
    expect(r2.helpfulCount).toBe(1);
    await expect(runAs(customerUser, meta, (ctx) => kb.feedback(ctx, internalId, true))).rejects.toThrow(/not found/i);
  });

  it('only drafts can be deleted; archive otherwise', async () => {
    await expect(runAs(admin, meta, (ctx) => kb.deleteArticle(ctx, publicId))).rejects.toThrow(/draft/);
    const archived = await runAs(admin, meta, (ctx) => kb.archiveArticle(ctx, customerBId));
    expect(archived.status).toBe('archived');
    const draft = await runAs(admin, meta, (ctx) => kb.createArticle(ctx, { title: `Temp ${SUFFIX}` }));
    const res = await runAs(admin, meta, (ctx) => kb.deleteArticle(ctx, draft.id));
    expect(res.deleted).toBe(true);
  });

  it('writes audit entries for mutations', async () => {
    const rows = await withSystem((tx) => tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.entityId, internalId)));
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'publish', 'update', 'restore_version']));
  });

  it('stats aggregate by status and visibility', async () => {
    const s = await runAs(admin, meta, (ctx) => kb.stats(ctx));
    expect(s.byStatus.published).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(s.topViewed)).toBe(true);
    await expect(runAs(customerUser, meta, (ctx) => kb.stats(ctx))).rejects.toThrow();
  });

  it('global search returns KB hits respecting portal visibility', async () => {
    const adminHits = await runAs(admin, meta, (ctx) => postgresSearchProvider.search(ctx, SUFFIX, ['kb'], 10));
    expect(adminHits.map((h) => h.id)).toEqual(expect.arrayContaining([internalId, customerAId, publicId]));
    const portalHits = await runAs(customerUser, meta, (ctx) => postgresSearchProvider.search(ctx, SUFFIX, ['kb', 'customer', 'asset'], 10));
    const ids = portalHits.map((h) => h.id);
    expect(portalHits.every((h) => h.type === 'kb')).toBe(true);
    expect(ids).not.toContain(internalId);
    expect(ids).toEqual(expect.arrayContaining([customerAId, publicId]));
  });
});
