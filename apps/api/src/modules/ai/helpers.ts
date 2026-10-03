import { eq, and, or, ilike, asc } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { getTicket } from '@/modules/tickets/service';
import { listTickets } from '@/modules/tickets/list';
import { timeline } from '@/modules/tickets/activity';
import { loadTicket, loadTicketByNumber, optionsOfType, type TicketRow } from '@/modules/tickets/common';
import { listCisMin } from '@/modules/cmdb/service';
import type { ListQuery } from '@/modules/tickets/schemas';
import { engineerDirectory } from '@/modules/iam/service';

/**
 * Shared helpers for the assistant's tools and query layer: name → id resolvers
 * that always stay within the caller's visibility, and the compact shapes that
 * keep tool results small enough for the model.
 */
export const isCustomerUser = (ctx: Pick<Ctx, 'user'>) => ctx.user.userType === 'customer';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ticketLink = (ctx: Ctx, id: string) => (isCustomerUser(ctx) ? `/portal/tickets/${id}` : `/tickets/${id}`);
export const trunc = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : s ?? null);
export const iso = (d: Date | string | null | undefined) => (d ? (d instanceof Date ? d.toISOString() : String(d)) : null);
export const like = (s: string) => `%${s.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;

// ---------------------------------------------------------------- resolvers (names → ids, always within the caller's visibility)

export async function resolveTicket(ctx: Ctx, ref: string): Promise<TicketRow> {
  const r = ref.trim();
  if (!r) throw new ValidationError('Ticket reference is required');
  if (UUID_RE.test(r)) return loadTicket(ctx, r);
  return loadTicketByNumber(ctx, r.toUpperCase());
}

/** Customer users are always resolved to their own customer regardless of the reference. */
export async function resolveCustomerId(ctx: Ctx, ref?: string | null, required = false): Promise<string | undefined> {
  if (isCustomerUser(ctx)) {
    if (!ctx.user.customerId) throw new ValidationError('Your account is not linked to a customer');
    return ctx.user.customerId;
  }
  const r = ref?.trim();
  if (!r) {
    if (required) throw new ValidationError('Customer is required (name, code or id)');
    return undefined;
  }
  if (UUID_RE.test(r)) {
    ctx.requireCustomer(r);
    return r;
  }
  const rows = await ctx.tx
    .select({ id: schema.customers.id, name: schema.customers.name, code: schema.customers.code })
    .from(schema.customers)
    .where(or(ilike(schema.customers.name, like(r)), ilike(schema.customers.code, r)))
    .orderBy(asc(schema.customers.name))
    .limit(6);
  const exact = rows.filter((c) => c.name.toLowerCase() === r.toLowerCase() || c.code.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!.id;
  if (!pick.length) throw new NotFoundError('Customer', `No customer matching "${r}" is visible to you`);
  throw new ValidationError(`Customer "${r}" is ambiguous: ${pick.map((c) => `${c.name} (${c.code})`).join(', ')}. Ask the user which one they mean.`);
}

export async function resolveOption(ctx: Ctx, type: string, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  const all = (await optionsOfType(ctx.tx, type)).filter((o) => o.isActive);
  const hit = all.find((o) => o.id === r) ?? all.find((o) => o.key.toLowerCase() === r.toLowerCase()) ?? all.find((o) => o.label.toLowerCase() === r.toLowerCase()) ?? all.find((o) => o.label.toLowerCase().startsWith(r.toLowerCase())) ?? all.find((o) => o.label.toLowerCase().includes(r.toLowerCase()));
  if (!hit) throw new ValidationError(`Unknown ${type.replace(/_/g, ' ')} "${r}". Valid values: ${all.map((o) => o.key).join(', ')}`);
  return hit;
}

export async function resolveService(ctx: Ctx, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  if (UUID_RE.test(r)) {
    const [s] = await ctx.tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(eq(schema.services.id, r)).limit(1);
    if (!s) throw new NotFoundError('Service');
    return s;
  }
  const rows = await ctx.tx.select({ id: schema.services.id, name: schema.services.name, key: schema.services.key }).from(schema.services).where(and(eq(schema.services.isActive, true), or(eq(schema.services.key, r), ilike(schema.services.name, like(r))))).limit(5);
  const exact = rows.filter((s) => s.key === r || s.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Service', `No service matching "${r}"`);
  throw new ValidationError(`Service "${r}" is ambiguous: ${pick.map((s) => s.name).join(', ')}`);
}

export async function resolveSite(ctx: Ctx, customerId: string, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  const rows = await ctx.tx.select({ id: schema.sites.id, name: schema.sites.name, code: schema.sites.code }).from(schema.sites).where(and(eq(schema.sites.customerId, customerId), or(ilike(schema.sites.name, like(r)), ilike(schema.sites.code, r)))).limit(5);
  const exact = rows.filter((s) => s.name.toLowerCase() === r.toLowerCase() || s.code.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Site', `No site matching "${r}" for this customer`);
  throw new ValidationError(`Site "${r}" is ambiguous: ${pick.map((s) => s.name).join(', ')}`);
}

export async function resolveCi(ctx: Ctx, ref: string, customerId?: string) {
  const r = ref.trim();
  if (UUID_RE.test(r)) return { id: r };
  const res = await listCisMin(ctx, { page: 1, pageSize: 8, q: r, customerId });
  const low = r.toLowerCase();
  const exact = res.items.filter((c) => c.name.toLowerCase() === low || c.hostname?.toLowerCase() === low || c.ipAddress === r);
  const pick = exact.length ? exact : res.items;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Configuration item', `No configuration item matching "${r}" is visible to you`);
  throw new ValidationError(`CI "${r}" is ambiguous: ${pick.map((c) => `${c.name}${c.hostname ? ` (${c.hostname})` : ''}`).join(', ')}. Ask the user which one.`);
}

export async function resolveEngineer(ctx: Ctx, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  if (r.toLowerCase() === 'me') return { id: ctx.user.id, name: ctx.user.name };
  if (UUID_RE.test(r)) {
    const [u] = await ctx.tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, r)).limit(1);
    if (!u) throw new NotFoundError('Engineer');
    return u;
  }
  const rows = await engineerDirectory(ctx, r);
  const exact = rows.filter((u) => u.email.toLowerCase() === r.toLowerCase() || u.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Engineer', `No engineer matching "${r}"`);
  throw new ValidationError(`Engineer "${r}" is ambiguous: ${pick.slice(0, 6).map((u) => `${u.name} <${u.email}>`).join(', ')}`);
}

export async function resolveTeam(ctx: Ctx, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  const rows = await ctx.tx.select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name }).from(schema.teams).where(and(eq(schema.teams.isActive, true), or(eq(schema.teams.id, UUID_RE.test(r) ? r : '00000000-0000-0000-0000-000000000000'), eq(schema.teams.key, r), ilike(schema.teams.name, like(r))))).limit(5);
  const exact = rows.filter((t) => t.key === r || t.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Team', `No team matching "${r}"`);
  throw new ValidationError(`Team "${r}" is ambiguous: ${pick.map((t) => t.name).join(', ')}`);
}

/** Contract by number (CON-2026-0001 style) or id, within the caller's visibility (RLS). */
export async function resolveContract(ctx: Ctx, ref: string) {
  const r = ref.trim();
  if (!r) throw new ValidationError('Contract reference is required');
  const cond = UUID_RE.test(r) ? eq(schema.contracts.id, r) : ilike(schema.contracts.number, r);
  const [row] = await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, customerId: schema.contracts.customerId }).from(schema.contracts).where(cond).limit(1);
  if (!row) throw new NotFoundError('Contract', `No contract matching "${r}" is visible to you`);
  ctx.requireCustomer(row.customerId);
  return row;
}

/** Field visit by number (FSV-… style) or id. */
export async function resolveVisit(ctx: Ctx, ref: string) {
  const r = ref.trim();
  if (!r) throw new ValidationError('Visit reference is required');
  const cond = UUID_RE.test(r) ? eq(schema.fieldVisits.id, r) : ilike(schema.fieldVisits.number, r);
  const [row] = await ctx.tx.select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, title: schema.fieldVisits.title, customerId: schema.fieldVisits.customerId, status: schema.fieldVisits.status }).from(schema.fieldVisits).where(cond).limit(1);
  if (!row) throw new NotFoundError('Field visit', `No visit matching "${r}" is visible to you`);
  ctx.requireCustomer(row.customerId);
  return row;
}

/** Knowledge article by number (KB-… style), id or exact title. */
export async function resolveArticle(ctx: Ctx, ref: string) {
  const r = ref.trim();
  if (!r) throw new ValidationError('Article reference is required');
  const cond = UUID_RE.test(r) ? eq(schema.kbArticles.id, r) : or(ilike(schema.kbArticles.number, r), ilike(schema.kbArticles.title, r));
  const rows = await ctx.tx.select({ id: schema.kbArticles.id, number: schema.kbArticles.number, title: schema.kbArticles.title, status: schema.kbArticles.status }).from(schema.kbArticles).where(cond).limit(3);
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) throw new NotFoundError('Knowledge article', `No article matching "${r}"`);
  throw new ValidationError(`Article "${r}" is ambiguous: ${rows.map((a) => `${a.number} ${a.title}`).join(', ')}`);
}

/** Asset by tag, serial number, name or id (optionally within one customer). */
export async function resolveAsset(ctx: Ctx, ref: string, customerId?: string) {
  const r = ref.trim();
  if (!r) throw new ValidationError('Asset reference is required');
  const conds = [UUID_RE.test(r) ? eq(schema.assets.id, r) : or(ilike(schema.assets.tag, r), ilike(schema.assets.serialNumber, r), ilike(schema.assets.name, like(r)))];
  if (customerId) conds.push(eq(schema.assets.customerId, customerId));
  const rows = await ctx.tx.select({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name, customerId: schema.assets.customerId, lifecycleStage: schema.assets.lifecycleStage }).from(schema.assets).where(and(...conds)).limit(6);
  const low = r.toLowerCase();
  const exact = rows.filter((a) => a.tag.toLowerCase() === low || a.name.toLowerCase() === low);
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('Asset', `No asset matching "${r}" is visible to you`);
  throw new ValidationError(`Asset "${r}" is ambiguous: ${pick.map((a) => `${a.tag} ${a.name}`).join(', ')}. Ask the user which one.`);
}

/** Any active person (staff or customer user) by "me", id, email or name. */
export async function resolveUser(ctx: Ctx, ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  if (r.toLowerCase() === 'me') return { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email };
  const cond = UUID_RE.test(r) ? eq(schema.users.id, r) : or(ilike(schema.users.email, r), ilike(schema.users.name, like(r)));
  const rows = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(and(cond, eq(schema.users.status, 'active'))).limit(6);
  const exact = rows.filter((u) => u.email.toLowerCase() === r.toLowerCase() || u.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new NotFoundError('User', `No user matching "${r}"`);
  throw new ValidationError(`User "${r}" is ambiguous: ${pick.map((u) => `${u.name} <${u.email}>`).join(', ')}`);
}

/** Parses a date or date-time the model produced; throws a clear error otherwise. */
export function parseWhen(value: string | null | undefined, label = 'date'): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`Could not understand the ${label} "${value}"; use an ISO date such as 2026-10-14 or 2026-10-14T09:00`);
  return d;
}

export const dayStr = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- compact shapes (keep tool results small)

type ListItem = Awaited<ReturnType<typeof listTickets>>['items'][number];
export const compactTicket = (ctx: Ctx, t: ListItem) => ({
  number: t.number,
  id: t.id,
  type: t.type,
  title: t.title,
  customer: t.customerName,
  site: t.siteName,
  service: t.serviceName,
  status: t.status.label,
  statusCategory: t.status.category,
  priority: t.priority?.label ?? null,
  category: t.categoryLabel,
  assignee: t.assigneeName,
  team: t.teamName,
  scope: t.scopeStatus,
  isMajor: t.isMajor,
  sla: t.sla ? { metric: t.sla.metric, state: t.sla.state, breached: t.sla.breached, dueAt: iso(t.sla.dueAt), remainingMinutes: t.sla.remainingMinutes } : null,
  dueAt: iso(t.dueAt),
  createdAt: iso(t.createdAt),
  resolvedAt: iso(t.resolvedAt),
  link: ticketLink(ctx, t.id),
});

type Detail = Awaited<ReturnType<typeof getTicket>>;
export function compactDetail(ctx: Ctx, d: Detail) {
  return {
    number: d.number,
    id: d.id,
    type: d.type,
    title: d.title,
    description: trunc(d.description, 1500),
    customer: d.customer?.name ?? null,
    site: d.site?.name ?? null,
    service: d.service?.name ?? null,
    contract: d.contract ? `${d.contract.number} (${d.contract.status}, ends ${d.contract.endDate})` : null,
    status: d.status?.label ?? null,
    statusCategory: d.status?.category ?? null,
    priority: d.priority?.label ?? null,
    impact: d.impact?.label ?? null,
    urgency: d.urgency?.label ?? null,
    category: d.category?.label ?? null,
    subcategory: d.subcategory?.label ?? null,
    domain: d.domain,
    scope: d.scopeStatus,
    assignee: d.assignee?.name ?? null,
    team: d.team?.name ?? null,
    requester: d.requester?.name ?? d.requesterContact?.name ?? null,
    isMajor: d.isMajor,
    escalationLevel: d.escalationLevel,
    tags: d.tags,
    primaryCi: d.cis.find((c) => c.role === 'primary')?.name ?? d.cis[0]?.name ?? null,
    cis: d.cis.map((c) => ({ name: c.name, hostname: c.hostname, ip: c.ipAddress })),
    links: d.links.map((l) => ({ type: l.linkType, direction: l.direction, number: l.ticket.number, title: l.ticket.title, status: l.ticket.status?.label ?? null })),
    slas: d.slas.map((s) => ({ metric: s.metric, state: s.state, dueAt: iso(s.dueAt), remainingMinutes: s.remainingMinutes, pctConsumed: s.pctConsumed, breached: s.breached })),
    resolutionNotes: trunc(d.resolutionNotes, 1000),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    dueAt: iso(d.dueAt),
    resolvedAt: iso(d.resolvedAt),
    closedAt: iso(d.closedAt),
    link: ticketLink(ctx, d.id),
  };
}

export const compactTimeline = (items: Awaited<ReturnType<typeof timeline>>['items'], max: number) =>
  items.slice(-max).map((i) => ({ at: iso(i.createdAt), by: i.actorName, kind: i.kind === 'comment' ? i.type : i.type, internal: i.isInternal, text: trunc(i.kind === 'comment' ? i.body : i.summary, 600) }));

export const period = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Fills the flag keys `ListQuery` requires (zod transforms make them required-but-undefined). */
export const listQuery = (q: Partial<ListQuery>): ListQuery => ({ page: 1, pageSize: 20, order: 'desc', unassigned: undefined, mine: undefined, watching: undefined, isMajor: undefined, open: undefined, ...q });

/** Display name of a customer the caller may see (used in previews). */
export async function customerName(ctx: Ctx, id: string): Promise<string> {
  ctx.requireCustomer(id);
  const [c] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
  if (!c) throw new NotFoundError('Customer');
  return c.name;
}

/** " for <customer name>" from the resolved id (never the model's wording), for facts lines. */
export const forCustomer = async (ctx: Ctx, customerId?: string | null): Promise<string> => (customerId ? ` for ${await customerName(ctx, customerId)}` : '');

/** Knowledge pages are shared by both shells. */
export const articleLink = (_ctx: Ctx, id: string) => `/knowledge/${id}`;
