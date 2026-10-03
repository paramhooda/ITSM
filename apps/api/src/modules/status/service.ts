import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { countRows } from '@/core/query';
import { config } from '@/config';
import { sha256, randomToken } from '@/lib/crypto';
import { resolvePortalCustomer } from '@/modules/portal/service';
import { isCustomerUser } from '@/modules/tickets/common';
import type { HealthReason, ServiceHealth } from '@/db/schema/status';
import { visibleAnnouncements, majorIncidentBanners, announcementShape, type AnnouncementView } from './announcements';
import { worstHealth } from './health';
import type { AnnouncementBody, AnnouncementPatch, AnnouncementListQuery, TokenBody } from './schemas';

/**
 * Announcements (staff-managed banners for customers and staff), the
 * customer's status page (business services with health, planned maintenance,
 * announcements, incident banners) and the tokens that open a public,
 * read-only copy of it.
 */

const OPEN = ['new', 'open', 'pending'] as const;
const MAINTENANCE_DAYS = 14;
const TOKEN_TOUCH_MS = 5 * 60_000;
const MANAGE = 'announcements:manage' as const;

// ---------------------------------------------------------------- announcements

async function sourceTicket(tx: Tx, id: string | null) {
  if (!id) return null;
  const [t] = await tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1);
  return t ?? null;
}

async function customerNames(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, string>();
  const rows = await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadAnnouncement(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.announcements).where(eq(schema.announcements.id, id)).limit(1);
  if (!row) throw new NotFoundError('Announcement');
  return row;
}

function validateWindow(startsAt: Date | null | undefined, endsAt: Date | null | undefined) {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) throw new ValidationError('The end of the window must be after its start');
}

export async function listAnnouncements(ctx: Ctx, q: AnnouncementListQuery) {
  ctx.require(MANAGE);
  const a = schema.announcements;
  const now = new Date();
  const conds = [];
  if (q.q) conds.push(or(ilike(a.title, `%${q.q}%`), ilike(a.body, `%${q.q}%`))!);
  if (q.type) conds.push(eq(a.type, q.type));
  if (q.audience) conds.push(eq(a.audience, q.audience));
  if (q.customerId) conds.push(sql`(cardinality(${a.customerIds}) = 0 OR ${a.customerIds} @> ARRAY[${q.customerId}::uuid])`);
  const state = q.state ?? 'live';
  if (state === 'live') conds.push(eq(a.isActive, true), lte(a.startsAt, now), or(isNull(a.endsAt), gt(a.endsAt, now))!);
  else if (state === 'scheduled') conds.push(eq(a.isActive, true), gt(a.startsAt, now));
  else if (state === 'ended') conds.push(or(eq(a.isActive, false), lte(a.endsAt, now))!);
  const where = conds.length ? and(...conds) : undefined;
  const total = await countRows(ctx.tx, sql`announcements`, where);
  const t = schema.tickets;
  const rows = await ctx.tx
    .select({ a, ticketId: t.id, ticketNumber: t.number, ticketTitle: t.title })
    .from(a)
    .leftJoin(t, eq(t.id, a.sourceTicketId))
    .where(where)
    .orderBy(desc(a.pinned), desc(a.startsAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const names = await customerNames(ctx.tx, rows.flatMap((r) => r.a.customerIds));
  const items = rows.map((r) => ({
    ...announcementShape(r.a, r.ticketId ? { id: r.ticketId, number: r.ticketNumber!, title: r.ticketTitle! } : null),
    customers: r.a.customerIds.map((id) => ({ id, name: names.get(id) ?? '…' })),
    state: !r.a.isActive ? 'ended' : r.a.startsAt > now ? 'scheduled' : r.a.endsAt && r.a.endsAt <= now ? 'ended' : 'live',
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function getAnnouncement(ctx: Ctx, id: string) {
  ctx.require(MANAGE);
  const row = await loadAnnouncement(ctx, id);
  const names = await customerNames(ctx.tx, row.customerIds);
  return { ...announcementShape(row, await sourceTicket(ctx.tx, row.sourceTicketId)), customers: row.customerIds.map((cid) => ({ id: cid, name: names.get(cid) ?? '…' })) };
}

export async function createAnnouncement(ctx: Ctx, input: AnnouncementBody) {
  ctx.require(MANAGE);
  const audience = input.audience ?? 'all';
  const customerIds = audience === 'staff' ? [] : [...new Set(input.customerIds ?? [])];
  for (const id of customerIds) ctx.requireCustomer(id);
  const startsAt = input.startsAt ?? new Date();
  validateWindow(startsAt, input.endsAt);
  if (input.sourceTicketId && !(await sourceTicket(ctx.tx, input.sourceTicketId))) throw new NotFoundError('Ticket');
  const [row] = await ctx.tx
    .insert(schema.announcements)
    .values({ title: input.title, body: input.body, type: input.type ?? 'info', audience, customerIds, startsAt, endsAt: input.endsAt ?? null, pinned: input.pinned ?? false, isActive: input.isActive ?? true, sourceTicketId: input.sourceTicketId ?? null, createdBy: ctx.user.id, updatedBy: ctx.user.id })
    .returning();
  await ctx.audit({ entityType: 'announcement', entityId: row!.id, entityLabel: row!.title, action: 'announcement.create', metadata: { type: row!.type, audience, customerIds, startsAt, endsAt: input.endsAt ?? null, sourceTicketId: input.sourceTicketId ?? null } });
  return announcementShape(row!, await sourceTicket(ctx.tx, row!.sourceTicketId));
}

export async function updateAnnouncement(ctx: Ctx, id: string, patch: AnnouncementPatch) {
  ctx.require(MANAGE);
  const before = await loadAnnouncement(ctx, id);
  const audience = patch.audience ?? before.audience;
  const customerIds = audience === 'staff' ? [] : patch.customerIds !== undefined ? [...new Set(patch.customerIds)] : before.customerIds;
  for (const cid of customerIds) ctx.requireCustomer(cid);
  const startsAt = patch.startsAt ?? before.startsAt;
  const endsAt = patch.endsAt !== undefined ? patch.endsAt : before.endsAt;
  validateWindow(startsAt, endsAt);
  if (patch.sourceTicketId && !(await sourceTicket(ctx.tx, patch.sourceTicketId))) throw new NotFoundError('Ticket');
  const set = {
    title: patch.title ?? before.title,
    body: patch.body ?? before.body,
    type: patch.type ?? before.type,
    audience,
    customerIds,
    startsAt,
    endsAt,
    pinned: patch.pinned ?? before.pinned,
    isActive: patch.isActive ?? before.isActive,
    sourceTicketId: patch.sourceTicketId !== undefined ? patch.sourceTicketId : before.sourceTicketId,
    updatedBy: ctx.user.id,
    updatedAt: new Date(),
  };
  const [row] = await ctx.tx.update(schema.announcements).set(set).where(eq(schema.announcements.id, id)).returning();
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const k of ['title', 'body', 'type', 'audience', 'customerIds', 'startsAt', 'endsAt', 'pinned', 'isActive', 'sourceTicketId'] as const) {
    if (JSON.stringify(before[k]) !== JSON.stringify(set[k])) changes[k] = { old: before[k], new: set[k] };
  }
  await ctx.audit({ entityType: 'announcement', entityId: id, entityLabel: row!.title, action: 'announcement.update', changes });
  return announcementShape(row!, await sourceTicket(ctx.tx, row!.sourceTicketId));
}

export async function deleteAnnouncement(ctx: Ctx, id: string) {
  ctx.require(MANAGE);
  const row = await loadAnnouncement(ctx, id);
  await ctx.tx.delete(schema.announcements).where(eq(schema.announcements.id, id));
  await ctx.audit({ entityType: 'announcement', entityId: id, entityLabel: row.title, action: 'announcement.delete' });
  return { ok: true };
}

/** The banners for the signed-in person: staff see 'all' and 'staff', customer users 'all' and 'customers' aimed at their organisation. */
export async function activeAnnouncements(ctx: Ctx): Promise<{ items: AnnouncementView[] }> {
  const customer = isCustomerUser(ctx);
  const items = await visibleAnnouncements(ctx.tx, { staff: !customer, customerId: customer ? ctx.user.customerId : null });
  return { items };
}

// ---------------------------------------------------------------- the status page

export interface StatusService {
  id: string;
  name: string;
  criticality: string;
  health: ServiceHealth;
  reasons: HealthReason[];
  computedAt: Date | null;
}
export interface MaintenanceItem {
  kind: 'pm' | 'change';
  id: string;
  number: string | null;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  /** YYYY-MM-DD for a PM occurrence without a scheduled visit. */
  day: string | null;
  status: string;
}

const HEALTH_LABEL: Record<ServiceHealth, string> = { good: 'Operational', degraded: 'Degraded', maintenance: 'Under maintenance', down: 'Major incident' };

async function statusFor(tx: Tx, customerId: string, now = new Date()) {
  const horizon = new Date(now.getTime() + MAINTENANCE_DAYS * 86_400_000);
  const c = schema.cis;
  const h = schema.serviceHealthSnapshots;
  const serviceRows = await tx
    .select({ id: c.id, name: c.name, criticality: c.criticality, health: h.health, reasons: h.reasons, computedAt: h.computedAt })
    .from(c)
    .innerJoin(schema.ciTypes, eq(schema.ciTypes.id, c.typeId))
    .leftJoin(h, eq(h.ciId, c.id))
    .where(and(eq(c.customerId, customerId), eq(schema.ciTypes.key, 'business_service'), sql`${c.status} <> 'retired'`))
    .orderBy(asc(c.name));
  const services: StatusService[] = serviceRows.map((r) => ({ id: r.id, name: r.name, criticality: r.criticality, health: (r.health as ServiceHealth | null) ?? 'good', reasons: (r.reasons as HealthReason[] | null) ?? [], computedAt: r.computedAt ?? null }));

  // Planned maintenance: PM occurrences and change windows in the next two weeks (and anything still running).
  const o = schema.pmOccurrences;
  const p = schema.pmPrograms;
  const fv = schema.fieldVisits;
  const occDate = sql<string>`coalesce(${o.scheduledDate}, ${o.plannedDate})::text`;
  const pmRows = await tx
    .select({ id: o.id, title: p.name, status: o.status, day: occDate, startsAt: fv.scheduledStart, endsAt: fv.scheduledEnd, number: fv.number })
    .from(o)
    .innerJoin(p, eq(p.id, o.programId))
    .leftJoin(fv, eq(fv.id, o.fieldVisitId))
    .where(and(eq(o.customerId, customerId), inArray(o.status, ['planned', 'scheduled', 'rescheduled']), sql`coalesce(${o.scheduledDate}, ${o.plannedDate}) BETWEEN ${now.toISOString().slice(0, 10)}::date AND ${horizon.toISOString().slice(0, 10)}::date`))
    .orderBy(asc(occDate))
    .limit(20);
  const t = schema.tickets;
  const st = alias(schema.configOptions, 'st');
  const cd = schema.changeDetails;
  const changeRows = await tx
    .select({ id: t.id, number: t.number, title: t.title, status: st.label, startsAt: cd.scheduledStart, endsAt: cd.scheduledEnd })
    .from(cd)
    .innerJoin(t, eq(t.id, cd.ticketId))
    .innerJoin(st, eq(st.id, t.statusId))
    .where(and(eq(t.customerId, customerId), inArray(st.statusCategory, [...OPEN]), lte(cd.scheduledStart, horizon), or(isNull(cd.scheduledEnd), gte(cd.scheduledEnd, now))!))
    .orderBy(asc(cd.scheduledStart))
    .limit(20);
  const maintenance: MaintenanceItem[] = [
    ...pmRows.map((r) => ({ kind: 'pm' as const, id: r.id, number: r.number ?? null, title: r.title, startsAt: r.startsAt ?? null, endsAt: r.endsAt ?? null, day: r.day, status: r.status })),
    ...changeRows.map((r) => ({ kind: 'change' as const, id: r.id, number: r.number, title: r.title, startsAt: r.startsAt, endsAt: r.endsAt, day: null, status: r.status ?? 'scheduled' })),
  ].sort((a, b) => (a.startsAt?.getTime() ?? Date.parse(`${a.day}T00:00:00Z`)) - (b.startsAt?.getTime() ?? Date.parse(`${b.day}T00:00:00Z`)));

  const announcements = await visibleAnnouncements(tx, { now, staff: false, customerId });
  const incidents = await majorIncidentBanners(tx, customerId);
  const overall = worstHealth(services.map((s) => s.health));
  return {
    generatedAt: now,
    overall,
    overallLabel: HEALTH_LABEL[overall],
    counts: { services: services.length, down: services.filter((s) => s.health === 'down').length, degraded: services.filter((s) => s.health === 'degraded').length, maintenance: services.filter((s) => s.health === 'maintenance').length },
    services,
    maintenance,
    announcements,
    incidents,
  };
}
type StatusData = Awaited<ReturnType<typeof statusFor>>;

/** The public copy carries words, not records: no ids, no links, no customer list. */
function publicView(d: StatusData) {
  return {
    generatedAt: d.generatedAt,
    overall: d.overall,
    overallLabel: d.overallLabel,
    counts: d.counts,
    services: d.services.map((s) => ({ name: s.name, health: s.health, label: HEALTH_LABEL[s.health], reasons: s.reasons.map((r) => r.text), until: s.reasons.find((r) => r.until)?.until ?? null })),
    maintenance: d.maintenance.map((m) => ({ kind: m.kind, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, day: m.day, status: m.status })),
    announcements: d.announcements.map((a) => ({ id: a.id, title: a.title, body: a.body, type: a.type, pinned: a.pinned, startsAt: a.startsAt, endsAt: a.endsAt })),
    incidents: d.incidents.map((i) => ({ title: i.title, declaredAt: i.declaredAt, latestUpdate: i.latestUpdate, nextUpdateDueAt: i.nextUpdateDueAt })),
  };
}

/** The portal's status page: the customer's own services; staff with tenant:all may preview a customer's page. */
export async function portalStatus(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:status', requested);
  return { customerId: scope.customerId, ...(await statusFor(ctx.tx, scope.customerId)) };
}

// ---------------------------------------------------------------- public status pages

const tokenView = (r: typeof schema.statusPageTokens.$inferSelect) => ({ id: r.id, customerId: r.customerId, label: r.label, tokenPrefix: r.tokenPrefix, isActive: r.isActive, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt });
export const statusPageUrl = (token: string) => `${config.APP_URL.replace(/\/$/, '')}/status/${token}`;

export async function listTokens(ctx: Ctx, customerId: string) {
  ctx.require('customers:manage', customerId);
  ctx.requireCustomer(customerId);
  const rows = await ctx.tx.select().from(schema.statusPageTokens).where(eq(schema.statusPageTokens.customerId, customerId)).orderBy(desc(schema.statusPageTokens.createdAt));
  return { items: rows.map(tokenView) };
}

/** Creates a token; the plaintext is returned once and never stored. */
export async function createToken(ctx: Ctx, input: TokenBody) {
  ctx.require('customers:manage', input.customerId);
  ctx.requireCustomer(input.customerId);
  const token = randomToken(24);
  const [row] = await ctx.tx.insert(schema.statusPageTokens).values({ customerId: input.customerId, label: input.label, tokenHash: sha256(token), tokenPrefix: token.slice(0, 6), createdBy: ctx.user.id }).returning();
  await ctx.audit({ entityType: 'status_page_token', entityId: row!.id, entityLabel: input.label, action: 'status_token.create', customerId: input.customerId });
  return { ...tokenView(row!), token, url: statusPageUrl(token) };
}

export async function revokeToken(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.statusPageTokens).where(eq(schema.statusPageTokens.id, id)).limit(1);
  if (!row) throw new NotFoundError('Status page token');
  ctx.require('customers:manage', row.customerId);
  const [updated] = await ctx.tx.update(schema.statusPageTokens).set({ isActive: false, updatedAt: new Date() }).where(eq(schema.statusPageTokens.id, id)).returning();
  await ctx.audit({ entityType: 'status_page_token', entityId: id, entityLabel: row.label, action: 'status_token.revoke', customerId: row.customerId });
  return tokenView(updated!);
}

export async function deleteToken(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.statusPageTokens).where(eq(schema.statusPageTokens.id, id)).limit(1);
  if (!row) throw new NotFoundError('Status page token');
  ctx.require('customers:manage', row.customerId);
  await ctx.tx.delete(schema.statusPageTokens).where(eq(schema.statusPageTokens.id, id));
  await ctx.audit({ entityType: 'status_page_token', entityId: id, entityLabel: row.label, action: 'status_token.delete', customerId: row.customerId });
  return { ok: true };
}

/** The public page behind a token: aggregate words only; null when the token is unknown or revoked. */
export async function publicStatus(token: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return withSystem(async (tx) => {
    const [row] = await tx.select().from(schema.statusPageTokens).where(and(eq(schema.statusPageTokens.tokenHash, sha256(token)), eq(schema.statusPageTokens.isActive, true))).limit(1);
    if (!row) return null;
    const [customer] = await tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, row.customerId)).limit(1);
    if (!customer) return null;
    const now = new Date();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > TOKEN_TOUCH_MS) await tx.update(schema.statusPageTokens).set({ lastUsedAt: now }).where(eq(schema.statusPageTokens.id, row.id));
    return { customer: { name: customer.name }, page: { label: row.label }, ...publicView(await statusFor(tx, row.customerId, now)) };
  });
}
