import { eq, and, or, asc } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { isCustomerUser } from './common';
import type { SavedViewInput } from './schemas';

/** Saved list views: private to the owner or shared with every MSP user. */
export async function listViews(ctx: Ctx, entity = 'ticket') {
  const conds = [eq(schema.savedViews.entity, entity)];
  if (isCustomerUser(ctx)) conds.push(eq(schema.savedViews.userId, ctx.user.id));
  else conds.push(or(eq(schema.savedViews.userId, ctx.user.id), eq(schema.savedViews.isShared, true))!);
  const rows = await ctx.tx.select().from(schema.savedViews).where(and(...conds)).orderBy(asc(schema.savedViews.sortOrder), asc(schema.savedViews.name));
  return { items: rows.map((r) => ({ ...r, isOwner: r.userId === ctx.user.id })) };
}

export async function createView(ctx: Ctx, input: SavedViewInput) {
  const shared = !isCustomerUser(ctx) && !!input.isShared;
  if (input.isDefault) await ctx.tx.update(schema.savedViews).set({ isDefault: false }).where(and(eq(schema.savedViews.userId, ctx.user.id), eq(schema.savedViews.entity, input.entity)));
  const [row] = await ctx.tx.insert(schema.savedViews).values({ userId: ctx.user.id, name: input.name, entity: input.entity, filters: input.filters, columns: input.columns, sort: input.sort ?? null, isShared: shared, isDefault: input.isDefault ?? false }).returning();
  await ctx.audit({ entityType: 'saved_view', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { entity: row.entity, shared } });
  return { ...row, isOwner: true };
}

export async function updateView(ctx: Ctx, id: string, patch: Partial<SavedViewInput>) {
  const [before] = await ctx.tx.select().from(schema.savedViews).where(eq(schema.savedViews.id, id)).limit(1);
  if (!before) throw new NotFoundError('Saved view');
  if (before.userId !== ctx.user.id && !ctx.can('admin:config')) throw new ForbiddenError('Only the owner can edit this view');
  const values: Partial<typeof schema.savedViews.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['name', 'filters', 'columns', 'sort', 'isDefault'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  if (patch.isShared !== undefined) values.isShared = !isCustomerUser(ctx) && patch.isShared;
  if (patch.isDefault) await ctx.tx.update(schema.savedViews).set({ isDefault: false }).where(and(eq(schema.savedViews.userId, ctx.user.id), eq(schema.savedViews.entity, before.entity)));
  const [row] = await ctx.tx.update(schema.savedViews).set(values).where(eq(schema.savedViews.id, id)).returning();
  await ctx.audit({ entityType: 'saved_view', entityId: id, entityLabel: row.name, action: 'update', changes: diffChanges(before as unknown as Record<string, unknown>, values as Record<string, unknown>) });
  return { ...row, isOwner: row.userId === ctx.user.id };
}

export async function deleteView(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.savedViews).where(eq(schema.savedViews.id, id)).limit(1);
  if (!row) throw new NotFoundError('Saved view');
  if (row.userId !== ctx.user.id && !ctx.can('admin:config')) throw new ForbiddenError('Only the owner can delete this view');
  await ctx.tx.delete(schema.savedViews).where(eq(schema.savedViews.id, id));
  await ctx.audit({ entityType: 'saved_view', entityId: id, entityLabel: row.name, action: 'delete' });
  return { ok: true };
}
