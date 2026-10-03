import { normalizePhone } from '@/lib/channels';
import { eq, and, ne, asc, desc, sql, inArray } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { loadCustomer } from './service';
import type { ContactInput } from './schemas';

const k = schema.contacts;

async function decorate(ctx: Ctx, rows: (typeof k.$inferSelect)[]) {
  if (!rows.length) return [];
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is string => !!x))];
  const sites = siteIds.length ? await ctx.tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, siteIds)) : [];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const users = userIds.length ? await ctx.tx.select({ id: schema.users.id, email: schema.users.email, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const siteName = new Map(sites.map((x) => [x.id, x.name]));
  const user = new Map(users.map((x) => [x.id, x]));
  return rows.map((r) => ({ ...r, siteName: r.siteId ? siteName.get(r.siteId) ?? null : null, portalUser: r.userId ? user.get(r.userId) ?? null : null }));
}

export async function listContacts(ctx: Ctx, customerId: string, includeInactive = false) {
  ctx.require('customers:read', customerId);
  ctx.requireCustomer(customerId);
  const conds = [eq(k.customerId, customerId)];
  if (!includeInactive) conds.push(eq(k.isActive, true));
  const rows = await ctx.tx.select().from(k).where(and(...conds)).orderBy(desc(k.isPrimary), asc(k.name));
  return decorate(ctx, rows);
}

export async function escalationContacts(ctx: Ctx, customerId: string) {
  ctx.require('customers:read', customerId);
  ctx.requireCustomer(customerId);
  const rows = await ctx.tx.select().from(k).where(and(eq(k.customerId, customerId), eq(k.isEscalation, true), eq(k.isActive, true))).orderBy(asc(sql`coalesce(${k.escalationLevel}, 99)`), asc(k.name));
  return decorate(ctx, rows);
}

function values(input: Partial<ContactInput>): Partial<typeof k.$inferInsert> {
  const v: Partial<typeof k.$inferInsert> = {};
  (['name', 'siteId', 'userId', 'email', 'phone', 'mobile', 'title', 'department', 'isPrimary', 'isEscalation', 'escalationLevel', 'notes', 'isActive', 'whatsappOptIn'] as const).forEach((key) => {
    if (input[key] !== undefined) (v as Record<string, unknown>)[key] = input[key];
  });
  if (v.mobile) v.mobile = normalizePhone(v.mobile) ?? v.mobile;
  if (v.whatsappOptIn !== undefined) v.whatsappOptedInAt = v.whatsappOptIn ? new Date() : null;
  if (v.email === '') v.email = null;
  if (v.email) v.email = v.email.toLowerCase();
  if (v.isEscalation === false) v.escalationLevel = null;
  return v;
}

async function validateSite(ctx: Ctx, customerId: string, siteId: string | null | undefined) {
  if (!siteId) return;
  const [site] = await ctx.tx.select({ customerId: schema.sites.customerId }).from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1);
  if (!site || site.customerId !== customerId) throw new ValidationError('Site does not belong to this customer');
}

export async function createContact(ctx: Ctx, customerId: string, input: ContactInput) {
  const customer = await loadCustomer(ctx, customerId);
  ctx.require('customers:manage', customerId);
  await validateSite(ctx, customerId, input.siteId);
  const v = values(input);
  if (v.isEscalation && !v.escalationLevel) v.escalationLevel = 1;
  if (v.isPrimary) await ctx.tx.update(k).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(k.customerId, customerId), eq(k.isPrimary, true)));
  const [row] = await ctx.tx.insert(k).values({ ...v, customerId, name: input.name, isActive: input.isActive ?? true }).returning();
  await ctx.audit({ entityType: 'contact', entityId: row.id, entityLabel: row.name, action: 'create', customerId, metadata: { customerCode: customer.code, isEscalation: row.isEscalation, escalationLevel: row.escalationLevel } });
  const [view] = await decorate(ctx, [row]);
  return view;
}

export async function updateContact(ctx: Ctx, id: string, patch: Partial<ContactInput>) {
  const [before] = await ctx.tx.select().from(k).where(eq(k.id, id)).limit(1);
  if (!before) throw new NotFoundError('Contact');
  ctx.requireCustomer(before.customerId);
  ctx.require('customers:manage', before.customerId);
  await validateSite(ctx, before.customerId, patch.siteId);
  const v = { ...values(patch), updatedAt: new Date() };
  if (v.isEscalation === true && !(v.escalationLevel ?? before.escalationLevel)) v.escalationLevel = 1;
  if (v.isPrimary === true) await ctx.tx.update(k).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(k.customerId, before.customerId), eq(k.isPrimary, true), ne(k.id, id)));
  const [after] = await ctx.tx.update(k).set(v).where(eq(k.id, id)).returning();
  await ctx.audit({ entityType: 'contact', entityId: id, entityLabel: after.name, action: 'update', customerId: before.customerId, changes: diffChanges(before as Record<string, unknown>, v as Record<string, unknown>) });
  const [view] = await decorate(ctx, [after]);
  return view;
}

export async function deleteContact(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(k).where(eq(k.id, id)).limit(1);
  if (!row) throw new NotFoundError('Contact');
  ctx.requireCustomer(row.customerId);
  ctx.require('customers:manage', row.customerId);
  const [refs] = (await ctx.tx.execute(sql`
    select (select count(*) from tickets where requester_contact_id = ${id}::uuid)::int as tickets,
           (select count(*) from assets where owner_contact_id = ${id}::uuid or assigned_contact_id = ${id}::uuid)::int as assets`)).rows as { tickets: number; assets: number }[];
  if (refs.tickets > 0 || refs.assets > 0) {
    await ctx.tx.update(k).set({ isActive: false, isPrimary: false, isEscalation: false, updatedAt: new Date() }).where(eq(k.id, id));
    await ctx.audit({ entityType: 'contact', entityId: id, entityLabel: row.name, action: 'deactivate', customerId: row.customerId, metadata: { references: refs } });
    return { deactivated: true, references: refs };
  }
  await ctx.tx.delete(k).where(eq(k.id, id));
  await ctx.audit({ entityType: 'contact', entityId: id, entityLabel: row.name, action: 'delete', customerId: row.customerId });
  return { deleted: true };
}
