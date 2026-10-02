import { eq, and, ne, asc, desc, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ConflictError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { optionLabels, uuidList } from '@/modules/contracts/common';
import { loadCustomer } from './service';
import type { SiteInput } from './schemas';

const s = schema.sites;

async function decorate(ctx: Ctx, rows: (typeof s.$inferSelect)[]) {
  if (!rows.length) return [];
  const labels = await optionLabels(ctx.tx, rows.map((r) => r.typeId));
  const counts = await ctx.tx.execute(sql`
    select x.id,
      (select count(*) from assets a where a.site_id = x.id)::int as assets,
      (select count(*) from cis c where c.site_id = x.id)::int as cis,
      (select count(*) from contacts k where k.site_id = x.id and k.is_active)::int as contacts,
      (select count(*) from tickets t join config_options o on o.id = t.status_id where t.site_id = x.id and o.status_category in ('new','open','pending'))::int as "openTickets"
    from sites x where x.id in (${uuidList(rows.map((r) => r.id))})`);
  const byId = new Map((counts.rows as { id: string; assets: number; cis: number; contacts: number; openTickets: number }[]).map((r) => [r.id, r]));
  return rows.map((r) => ({
    ...r,
    typeLabel: r.typeId ? labels.get(r.typeId)?.label ?? null : null,
    counts: { assets: Number(byId.get(r.id)?.assets ?? 0), cis: Number(byId.get(r.id)?.cis ?? 0), contacts: Number(byId.get(r.id)?.contacts ?? 0), openTickets: Number(byId.get(r.id)?.openTickets ?? 0) },
  }));
}

export async function listSites(ctx: Ctx, customerId: string, includeInactive = false) {
  ctx.require('customers:read', customerId);
  ctx.requireCustomer(customerId);
  const conds = [eq(s.customerId, customerId)];
  if (!includeInactive) conds.push(eq(s.isActive, true));
  const rows = await ctx.tx.select().from(s).where(and(...conds)).orderBy(desc(s.isPrimary), asc(s.name));
  return decorate(ctx, rows);
}

export async function getSite(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!row) throw new NotFoundError('Site');
  ctx.requireCustomer(row.customerId);
  ctx.require('customers:read', row.customerId);
  const [view] = await decorate(ctx, [row]);
  return view;
}

async function nextSiteCode(ctx: Ctx, customerId: string, name: string) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12) || 'SITE';
  const existing = new Set((await ctx.tx.select({ code: s.code }).from(s).where(eq(s.customerId, customerId))).map((r) => r.code));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!existing.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

function values(input: Partial<SiteInput>): Partial<typeof s.$inferInsert> {
  const v: Partial<typeof s.$inferInsert> = {};
  (['code', 'name', 'typeId', 'address', 'timezone', 'phone', 'isPrimary', 'isActive', 'businessHoursCalendarId', 'notes', 'customFields'] as const).forEach((k) => {
    if (input[k] !== undefined) (v as Record<string, unknown>)[k] = input[k];
  });
  if (v.code) v.code = v.code.toUpperCase();
  return v;
}

export async function createSite(ctx: Ctx, customerId: string, input: SiteInput) {
  const customer = await loadCustomer(ctx, customerId);
  ctx.require('customers:manage', customerId);
  const code = (input.code?.trim() || (await nextSiteCode(ctx, customerId, input.name))).toUpperCase();
  const [dup] = await ctx.tx.select({ id: s.id }).from(s).where(and(eq(s.customerId, customerId), eq(s.code, code))).limit(1);
  if (dup) throw new ConflictError(`Site code ${code} already exists for ${customer.name}`);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(s).where(eq(s.customerId, customerId));
  const isPrimary = input.isPrimary ?? count === 0;
  if (isPrimary) await ctx.tx.update(s).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(s.customerId, customerId), eq(s.isPrimary, true)));
  const [row] = await ctx.tx.insert(s).values({ ...values(input), customerId, code, name: input.name, isPrimary, isActive: input.isActive ?? true }).returning();
  await ctx.audit({ entityType: 'site', entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: 'create', customerId, metadata: { customerCode: customer.code, isPrimary } });
  const [view] = await decorate(ctx, [row]);
  return view;
}

export async function updateSite(ctx: Ctx, id: string, patch: Partial<SiteInput>) {
  const [before] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!before) throw new NotFoundError('Site');
  ctx.requireCustomer(before.customerId);
  ctx.require('customers:manage', before.customerId);
  const v = { ...values(patch), updatedAt: new Date() };
  if (v.code && v.code !== before.code) {
    const [dup] = await ctx.tx.select({ id: s.id }).from(s).where(and(eq(s.customerId, before.customerId), eq(s.code, v.code), ne(s.id, id))).limit(1);
    if (dup) throw new ConflictError(`Site code ${v.code} already exists for this customer`);
  }
  if (v.isPrimary === true) await ctx.tx.update(s).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(s.customerId, before.customerId), eq(s.isPrimary, true), ne(s.id, id)));
  if (v.isPrimary === false && before.isPrimary) {
    // keep exactly one primary site when there are others
    const [other] = await ctx.tx.select({ id: s.id }).from(s).where(and(eq(s.customerId, before.customerId), ne(s.id, id), eq(s.isActive, true))).orderBy(asc(s.name)).limit(1);
    if (other) await ctx.tx.update(s).set({ isPrimary: true, updatedAt: new Date() }).where(eq(s.id, other.id));
  }
  const [after] = await ctx.tx.update(s).set(v).where(eq(s.id, id)).returning();
  await ctx.audit({ entityType: 'site', entityId: id, entityLabel: `${after.code} ${after.name}`, action: 'update', customerId: before.customerId, changes: diffChanges(before as Record<string, unknown>, v as Record<string, unknown>) });
  const [view] = await decorate(ctx, [after]);
  return view;
}

export async function deleteSite(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!row) throw new NotFoundError('Site');
  ctx.requireCustomer(row.customerId);
  ctx.require('customers:manage', row.customerId);
  const [refs] = (await ctx.tx.execute(sql`
    select (select count(*) from tickets where site_id = ${id}::uuid)::int as tickets,
           (select count(*) from assets where site_id = ${id}::uuid)::int as assets,
           (select count(*) from cis where site_id = ${id}::uuid)::int as cis,
           (select count(*) from contract_sites where site_id = ${id}::uuid)::int as contracts`)).rows as { tickets: number; assets: number; cis: number; contracts: number }[];
  if (refs.tickets > 0 || refs.assets > 0 || refs.cis > 0 || refs.contracts > 0) {
    await ctx.tx.update(s).set({ isActive: false, isPrimary: false, updatedAt: new Date() }).where(eq(s.id, id));
    await ctx.audit({ entityType: 'site', entityId: id, entityLabel: `${row.code} ${row.name}`, action: 'deactivate', customerId: row.customerId, metadata: { references: refs } });
    return { deactivated: true, references: refs };
  }
  await ctx.tx.delete(s).where(eq(s.id, id));
  await ctx.audit({ entityType: 'site', entityId: id, entityLabel: `${row.code} ${row.name}`, action: 'delete', customerId: row.customerId });
  if (row.isPrimary) {
    const [other] = await ctx.tx.select({ id: s.id }).from(s).where(and(eq(s.customerId, row.customerId), eq(s.isActive, true))).orderBy(asc(s.name)).limit(1);
    if (other) await ctx.tx.update(s).set({ isPrimary: true }).where(eq(s.id, other.id));
  }
  return { deleted: true };
}
