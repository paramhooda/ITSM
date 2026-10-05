import { eq, and, inArray, sql, type SQL } from 'drizzle-orm';
import { KNOWN_ERROR_STATUS_LABELS, KNOWN_ERROR_STATUSES, type KnownErrorStatus } from '@itsm/shared';
import { schema, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { limitOffset } from '@/core/query';
import { config } from '@/config';
import { addActivity, isCustomerUser, loadTicket, loadTicketByNumber, optionById, optionMap, requireAction, toLabel, userIdOf, type TicketRow } from '@/modules/tickets/common';
import { resolvePortalCustomer } from '@/modules/portal/service';
import { queueNotification, type Recipient } from '@/modules/notifications/dispatch';
import type { ListQuery, SuggestQuery, KnownErrorPatch, PublishBody, PortalListQuery, PortalSuggestQuery } from './schemas';

/**
 * Known error database. A known error is a problem record flagged as such on
 * its Problem analysis tab; the entry lives on `problem_details` (status, fix
 * change, customer-facing wording, portal publication). Problems carry a
 * customer id, so row-level security, `requireRead` and `resolvePortalCustomer`
 * fence every read; the portal functions project explicit customer-safe fields
 * and never the internal workaround, root cause or investigation.
 *
 * `tickets/service` and `tickets/status` call back into this module through
 * dynamic imports; this file never imports them statically (cycle).
 */

type OptionLabel = ReturnType<typeof toLabel>;
type Row = Record<string, unknown>;

export interface KnownErrorRow {
  id: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string;
  serviceId: string | null;
  serviceName: string | null;
  ticketStatus: OptionLabel;
  keStatus: KnownErrorStatus;
  keStatusLabel: string;
  workaround: string | null;
  rootCause: string | null;
  fixChange: { id: string; number: string; title: string; status: OptionLabel } | null;
  /** Incidents linked through an inbound `problem_of` link. */
  incidents: number;
  portalVisible: boolean;
  publishedAt: Date | null;
  identifiedAt: Date | null;
  keStatusAt: Date | null;
  updatedAt: Date;
  assigneeName: string | null;
  kbArticleId: string | null;
}

export interface KnownErrorDetail extends KnownErrorRow {
  symptoms: string | null;
  impactSummary: string | null;
  investigation: string | null;
  permanentFix: string | null;
  customerSummary: string | null;
  customerWorkaround: string | null;
  publishedByName: string | null;
  teamName: string | null;
  cis: { id: string; name: string; hostname: string | null; role: string }[];
  linkedIncidents: { id: string; number: string; title: string; status: OptionLabel; createdAt: Date; linkId: string }[];
  article: { id: string; number: string; title: string; status: string } | null;
  permissions: { manage: boolean; publish: boolean };
}

export interface KnownErrorStats {
  total: number;
  open: number;
  fixInProgress: number;
  resolved: number;
  retired: number;
  published: number;
  incidentsLinked30d: number;
  byService: { id: string | null; name: string; count: number }[];
  mostLinked: { id: string; number: string; title: string; incidents: number }[];
}

/** What a customer sees: the customer wording only, never the internal fields. */
export interface PortalKnownError {
  id: string;
  number: string;
  title: string;
  keStatus: KnownErrorStatus;
  summary: string | null;
  workaround: string | null;
  service: { id: string; name: string } | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface KedbSettings {
  notifyCustomers: boolean;
  suggestLimit: number;
  resolveOnFix: boolean;
}

const KE_STATUS = sql`coalesce(pd.ke_status, 'open')`;
const ACTIVE = sql`${KE_STATUS} IN ('open', 'fix_in_progress')`;
const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const asKeStatus = (v: unknown): KnownErrorStatus => ((KNOWN_ERROR_STATUSES as readonly string[]).includes(String(v)) ? (v as KnownErrorStatus) : 'open');
const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------- settings

export async function loadKedbSettings(tx: Tx): Promise<KedbSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['known_errors.notify_customers', 'known_errors.suggest_limit', 'known_errors.resolve_on_fix']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const n = Number(get('known_errors.suggest_limit'));
  return {
    notifyCustomers: get('known_errors.notify_customers') !== false,
    suggestLimit: Number.isFinite(n) && n >= 1 ? Math.min(10, Math.round(n)) : 5,
    resolveOnFix: get('known_errors.resolve_on_fix') !== false,
  };
}

// ---------------------------------------------------------------- staff reads

const FROM = sql`FROM tickets t JOIN problem_details pd ON pd.ticket_id = t.id`;
const JOINS = sql`LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN services sv ON sv.id = t.service_id LEFT JOIN users asg ON asg.id = t.assignee_id LEFT JOIN tickets fc ON fc.id = pd.fix_change_id`;
/** Incidents linked through an inbound `problem_of` link; a request or problem linked the same way is not an incident. */
const INCIDENTS = sql`(SELECT count(*)::int FROM ticket_links l JOIN tickets s ON s.id = l.source_ticket_id AND s.type = 'incident' WHERE l.target_ticket_id = t.id AND l.link_type = 'problem_of')`;
const COLS = sql`t.id, t.number, t.title, t.customer_id AS "customerId", cu.name AS "customerName", t.service_id AS "serviceId", sv.name AS "serviceName", t.status_id AS "statusId",
  ${KE_STATUS} AS "keStatus", pd.workaround, pd.root_cause AS "rootCause", fc.id AS "fixChangeId", fc.number AS "fixChangeNumber", fc.title AS "fixChangeTitle", fc.status_id AS "fixChangeStatusId",
  ${INCIDENTS} AS incidents, pd.portal_visible AS "portalVisible", pd.published_at AS "publishedAt", pd.ke_identified_at AS "identifiedAt", pd.ke_status_at AS "keStatusAt", greatest(pd.updated_at, t.updated_at) AS "updatedAt",
  asg.name AS "assigneeName", pd.kb_article_id AS "kbArticleId"`;
const search = (term: string) => sql`(t.search_vector @@ websearch_to_tsquery('simple', ${term}) OR pd.ke_search_vector @@ websearch_to_tsquery('simple', ${term}) OR similarity(t.title, ${term}) > 0.25)`;
const rank = (term: string) => sql`(ts_rank(t.search_vector, websearch_to_tsquery('simple', ${term})) + ts_rank(pd.ke_search_vector, websearch_to_tsquery('simple', ${term})) + similarity(t.title, ${term}))`;

/** Base predicates of every staff read: problems flagged as known errors, SOC fenced like the ticket list; RLS fences customers. */
function baseConds(ctx: Ctx, customerId?: string | null): SQL[] {
  if (isCustomerUser(ctx)) throw new ForbiddenError('The known error database is available to staff; customers use the portal view');
  ctx.require('kedb:read', customerId ?? undefined);
  const conds: SQL[] = [sql`t.type = 'problem'`, sql`pd.is_known_error`];
  if (!ctx.can('soc:read')) conds.push(sql`t.domain <> 'soc'`);
  if (customerId) {
    ctx.requireCustomer(customerId);
    conds.push(sql`t.customer_id = ${customerId}::uuid`);
  }
  return conds;
}

function staffWhere(ctx: Ctx, q: Partial<ListQuery>): SQL[] {
  const conds = baseConds(ctx, q.customerId);
  const status = q.status ?? 'active';
  if (status === 'active') conds.push(ACTIVE);
  else if (status !== 'all') conds.push(sql`${KE_STATUS} = ${status}`);
  const term = q.q?.trim();
  if (term) conds.push(search(term));
  if (q.hasFixChange !== undefined) conds.push(q.hasFixChange ? sql`pd.fix_change_id IS NOT NULL` : sql`pd.fix_change_id IS NULL`);
  if (q.portalVisible !== undefined) conds.push(sql`pd.portal_visible = ${q.portalVisible}`);
  if (q.serviceId) conds.push(sql`t.service_id = ${q.serviceId}::uuid`);
  if (q.ciId) conds.push(sql`(t.primary_ci_id = ${q.ciId}::uuid OR EXISTS (SELECT 1 FROM ticket_cis tc WHERE tc.ticket_id = t.id AND tc.ci_id = ${q.ciId}::uuid))`);
  return conds;
}

async function toRows(ctx: Ctx, raw: Row[]): Promise<KnownErrorRow[]> {
  const opts = await optionMap(ctx.tx, raw.flatMap((r) => [r.statusId as string, r.fixChangeStatusId as string | null]));
  return raw.map((r) => ({
    id: String(r.id),
    number: String(r.number),
    title: String(r.title),
    customerId: String(r.customerId),
    customerName: String(r.customerName ?? ''),
    serviceId: (r.serviceId as string | null) ?? null,
    serviceName: (r.serviceName as string | null) ?? null,
    ticketStatus: toLabel(opts.get(String(r.statusId))),
    keStatus: asKeStatus(r.keStatus),
    keStatusLabel: KNOWN_ERROR_STATUS_LABELS[asKeStatus(r.keStatus)],
    workaround: (r.workaround as string | null) ?? null,
    rootCause: (r.rootCause as string | null) ?? null,
    fixChange: r.fixChangeId ? { id: String(r.fixChangeId), number: String(r.fixChangeNumber), title: String(r.fixChangeTitle), status: toLabel(opts.get(String(r.fixChangeStatusId))) } : null,
    incidents: num(r.incidents),
    portalVisible: !!r.portalVisible,
    publishedAt: asDate(r.publishedAt),
    identifiedAt: asDate(r.identifiedAt),
    keStatusAt: asDate(r.keStatusAt),
    updatedAt: asDate(r.updatedAt) ?? new Date(),
    assigneeName: (r.assigneeName as string | null) ?? null,
    kbArticleId: (r.kbArticleId as string | null) ?? null,
  }));
}

const SORTS: Record<string, SQL> = {
  updatedAt: sql`greatest(pd.updated_at, t.updated_at)`,
  identifiedAt: sql`pd.ke_identified_at`,
  publishedAt: sql`pd.published_at`,
  incidents: INCIDENTS,
  title: sql`t.title`,
  number: sql`t.number`,
  status: sql`array_position(ARRAY['open', 'fix_in_progress', 'resolved', 'retired'], ${KE_STATUS})`,
};

export async function listKnownErrors(ctx: Ctx, q: ListQuery): Promise<{ items: KnownErrorRow[]; total: number; page: number; pageSize: number }> {
  const conds = staffWhere(ctx, q);
  const where = sql.join(conds, sql` AND `);
  const term = q.q?.trim();
  const dir = q.order === 'asc' ? sql`ASC` : sql`DESC`;
  const sortCol = SORTS[q.sort ?? ''] ?? SORTS.updatedAt!;
  const order = term ? sql`${rank(term)} DESC, ${sortCol} ${dir} NULLS LAST` : sql`${sortCol} ${dir} NULLS LAST`;
  const { limit, offset } = limitOffset(q);
  const [count] = (await ctx.tx.execute(sql`SELECT count(*)::int AS n ${FROM} WHERE ${where}`)).rows as { n: number }[];
  const raw = (await ctx.tx.execute(sql`SELECT ${COLS} ${FROM} ${JOINS} WHERE ${where} ORDER BY ${order}, t.created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows as Row[];
  return { items: await toRows(ctx, raw), total: num(count?.n), page: q.page, pageSize: q.pageSize };
}

export async function knownErrorStats(ctx: Ctx, customerId?: string | null): Promise<KnownErrorStats> {
  const conds = baseConds(ctx, customerId);
  const where = sql.join(conds, sql` AND `);
  const soc = ctx.can('soc:read') ? sql`` : sql`AND p.domain <> 'soc'`;
  const cust = customerId ? sql`AND p.customer_id = ${customerId}::uuid` : sql``;
  const [agg] = (await ctx.tx.execute(sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE ${KE_STATUS} = 'open')::int AS open,
      count(*) FILTER (WHERE ${KE_STATUS} = 'fix_in_progress')::int AS fix_in_progress,
      count(*) FILTER (WHERE ${KE_STATUS} = 'resolved')::int AS resolved,
      count(*) FILTER (WHERE ${KE_STATUS} = 'retired')::int AS retired,
      count(*) FILTER (WHERE pd.portal_visible)::int AS published,
      (SELECT count(*)::int FROM ticket_links l JOIN tickets s ON s.id = l.source_ticket_id AND s.type = 'incident' JOIN tickets p ON p.id = l.target_ticket_id JOIN problem_details pp ON pp.ticket_id = p.id
        WHERE l.link_type = 'problem_of' AND pp.is_known_error AND l.created_at >= now() - interval '30 days' ${cust} ${soc}) AS incidents_30d
    ${FROM} WHERE ${where}`)).rows as Row[];
  const byService = (await ctx.tx.execute(sql`
    SELECT sv.id, coalesce(sv.name, 'No service') AS name, count(*)::int AS count ${FROM} LEFT JOIN services sv ON sv.id = t.service_id
    WHERE ${where} AND ${ACTIVE} GROUP BY sv.id, sv.name ORDER BY count DESC, name LIMIT 8`)).rows as Row[];
  const mostLinked = (await ctx.tx.execute(sql`
    SELECT t.id, t.number, t.title, ${INCIDENTS} AS incidents ${FROM} WHERE ${where} ORDER BY incidents DESC, t.updated_at DESC LIMIT 5`)).rows as Row[];
  return {
    total: num(agg?.total),
    open: num(agg?.open),
    fixInProgress: num(agg?.fix_in_progress),
    resolved: num(agg?.resolved),
    retired: num(agg?.retired),
    published: num(agg?.published),
    incidentsLinked30d: num(agg?.incidents_30d),
    byService: byService.map((r) => ({ id: (r.id as string | null) ?? null, name: String(r.name), count: num(r.count) })),
    mostLinked: mostLinked.filter((r) => num(r.incidents) > 0).map((r) => ({ id: String(r.id), number: String(r.number), title: String(r.title), incidents: num(r.incidents) })),
  };
}

/** The staff row of one known error (the caller has already loaded the ticket). */
async function rowOf(ctx: Ctx, ticketId: string): Promise<KnownErrorRow | null> {
  const raw = (await ctx.tx.execute(sql`SELECT ${COLS} ${FROM} ${JOINS} WHERE t.id = ${ticketId}::uuid AND pd.is_known_error LIMIT 1`)).rows as Row[];
  return (await toRows(ctx, raw))[0] ?? null;
}

async function loadKnownErrorTicket(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'problem') throw new NotFoundError('Known error');
  const [pd] = await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1);
  if (!pd?.isKnownError) throw new NotFoundError('Known error');
  return { t, pd };
}

export async function getKnownError(ctx: Ctx, ticketId: string): Promise<KnownErrorDetail> {
  const { t, pd } = await loadKnownErrorTicket(ctx, ticketId);
  if (isCustomerUser(ctx)) throw new ForbiddenError('The known error database is available to staff; customers use the portal view');
  // Whoever manages the problem may read its known error record too (a custom role without kedb:read still flags problems).
  if (!ctx.can('kedb:read', t.customerId) && !ctx.can('problems:manage', t.customerId)) throw new ForbiddenError('Missing permission: kedb:read');
  const row = await rowOf(ctx, t.id);
  if (!row) throw new NotFoundError('Known error');
  const [team] = t.assignedTeamId ? await ctx.tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, t.assignedTeamId)).limit(1) : [];
  const [publisher] = pd.publishedBy ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, pd.publishedBy)).limit(1) : [];
  const cis = await ctx.tx.select({ id: schema.cis.id, name: schema.cis.name, hostname: schema.cis.hostname, role: schema.ticketCis.role }).from(schema.ticketCis).innerJoin(schema.cis, eq(schema.cis.id, schema.ticketCis.ciId)).where(eq(schema.ticketCis.ticketId, t.id));
  const links = await ctx.tx
    .select({ linkId: schema.ticketLinks.id, id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, statusId: schema.tickets.statusId, createdAt: schema.tickets.createdAt, linkedAt: schema.ticketLinks.createdAt })
    .from(schema.ticketLinks)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketLinks.sourceTicketId))
    .where(and(eq(schema.ticketLinks.targetTicketId, t.id), eq(schema.ticketLinks.linkType, 'problem_of'), eq(schema.tickets.type, 'incident')));
  const opts = await optionMap(ctx.tx, links.map((l) => l.statusId));
  const [article] = pd.kbArticleId ? await ctx.tx.select({ id: schema.kbArticles.id, number: schema.kbArticles.number, title: schema.kbArticles.title, status: schema.kbArticles.status }).from(schema.kbArticles).where(eq(schema.kbArticles.id, pd.kbArticleId)).limit(1) : [];
  return {
    ...row,
    symptoms: pd.symptoms,
    impactSummary: pd.impactSummary,
    investigation: pd.investigation,
    permanentFix: pd.permanentFix,
    customerSummary: pd.customerSummary,
    customerWorkaround: pd.customerWorkaround,
    publishedByName: publisher?.name ?? null,
    teamName: team?.name ?? null,
    cis: cis.map((c) => ({ id: c.id, name: c.name, hostname: c.hostname, role: c.role })),
    linkedIncidents: links
      .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
      .map((l) => ({ id: l.id, number: l.number, title: l.title, status: toLabel(opts.get(l.statusId)), createdAt: l.createdAt, linkId: l.linkId })),
    article: article ?? null,
    permissions: { manage: ctx.can('problems:manage', t.customerId), publish: ctx.can('kedb:publish', t.customerId) },
  };
}

// ---------------------------------------------------------------- matching

export async function suggestKnownErrors(ctx: Ctx, q: SuggestQuery): Promise<{ items: (KnownErrorRow & { score: number })[] }> {
  const term = q.q.trim();
  if (term.length < 2) return { items: [] };
  const conds = baseConds(ctx, q.customerId);
  conds.push(ACTIVE);
  conds.push(sql`(t.search_vector @@ plainto_tsquery('simple', ${term}) OR pd.ke_search_vector @@ plainto_tsquery('simple', ${term}) OR similarity(t.title, ${term}) > 0.2)`);
  if (q.excludeTicketId) conds.push(sql`t.id <> ${q.excludeTicketId}::uuid`);
  const limit = Math.min(10, Math.max(1, q.limit ?? (await loadKedbSettings(ctx.tx)).suggestLimit));
  const score = sql`(ts_rank(t.search_vector, plainto_tsquery('simple', ${term})) + ts_rank(pd.ke_search_vector, plainto_tsquery('simple', ${term})) + similarity(t.title, ${term})
    + CASE WHEN ${q.serviceId ?? null}::uuid IS NOT NULL AND t.service_id = ${q.serviceId ?? null}::uuid THEN 0.5 ELSE 0 END
    + CASE WHEN ${q.ciId ?? null}::uuid IS NOT NULL AND (t.primary_ci_id = ${q.ciId ?? null}::uuid OR EXISTS (SELECT 1 FROM ticket_cis tc WHERE tc.ticket_id = t.id AND tc.ci_id = ${q.ciId ?? null}::uuid)) THEN 0.3 ELSE 0 END)`;
  const raw = (await ctx.tx.execute(sql`SELECT ${COLS}, ${score} AS score ${FROM} ${JOINS} WHERE ${sql.join(conds, sql` AND `)} ORDER BY score DESC, pd.updated_at DESC LIMIT ${limit}`)).rows as Row[];
  const rows = await toRows(ctx, raw);
  return { items: rows.map((r, i) => ({ ...r, score: Number(raw[i]!.score) })).filter((r) => r.score > 0) };
}

/**
 * The known error an incident is linked to (outbound `problem_of` to a flagged
 * problem), or the best matches for it. Returns null without failing when the
 * caller lacks the permission, so a ticket read never breaks for a role
 * without it. Customer users get the portal shape and published entries only.
 */
export async function matchForIncident(ctx: Ctx, ticket: TicketRow): Promise<{ linked: KnownErrorRow | PortalKnownError | null; suggestions: (KnownErrorRow | PortalKnownError)[] } | null> {
  const customer = isCustomerUser(ctx);
  if (customer ? !ctx.can('portal:kedb', ticket.customerId) : !ctx.can('kedb:read', ticket.customerId)) return null;
  const visible = customer ? sql`AND pd.portal_visible` : sql``;
  const [link] = (await ctx.tx.execute(sql`
    SELECT p.id FROM ticket_links l JOIN tickets p ON p.id = l.target_ticket_id JOIN problem_details pd ON pd.ticket_id = p.id
    WHERE l.source_ticket_id = ${ticket.id}::uuid AND l.link_type = 'problem_of' AND pd.is_known_error AND p.customer_id = ${ticket.customerId}::uuid ${visible}
    ORDER BY l.created_at DESC LIMIT 1`)).rows as { id: string }[];
  if (customer) {
    const linked = link ? await portalRowOf(ctx, ticket.customerId, link.id) : null;
    if (linked) return { linked, suggestions: [] };
    const res = await suggestPortalKnownErrors(ctx, { q: ticket.title, serviceId: ticket.serviceId ?? undefined });
    return { linked: null, suggestions: res.items };
  }
  const linked = link ? await rowOf(ctx, link.id) : null;
  if (linked) return { linked, suggestions: [] };
  const res = await suggestKnownErrors(ctx, { q: ticket.title, customerId: ticket.customerId, serviceId: ticket.serviceId ?? undefined, ciId: ticket.primaryCiId ?? undefined, excludeTicketId: ticket.id });
  return { linked: null, suggestions: res.items };
}

// ---------------------------------------------------------------- writes

async function resolveFixChange(ctx: Ctx, t: TicketRow, patch: KnownErrorPatch): Promise<TicketRow | null | undefined> {
  if (patch.fixChangeNumber) {
    const fix = await loadTicketByNumber(ctx, patch.fixChangeNumber);
    return assertFixChange(t, fix);
  }
  if (patch.fixChangeId === undefined) return undefined;
  if (patch.fixChangeId === null) return null;
  return assertFixChange(t, await loadTicket(ctx, patch.fixChangeId));
}

function assertFixChange(problem: TicketRow, fix: TicketRow): TicketRow {
  if (fix.type !== 'change') throw new ValidationError('The permanent fix must be a change ticket');
  if (fix.customerId !== problem.customerId) throw new ValidationError('The permanent fix must be a change of the same customer');
  return fix;
}

/**
 * Known-error fields of a problem (status, fix change, customer wording).
 * Called by the KEDB page and by `updateProblemDetails`, so the ProblemForm
 * and the record share one audited path. Flagging a problem for the first time
 * stamps the identification date and opens the lifecycle.
 */
export async function updateKnownError(ctx: Ctx, ticketId: string, patch: KnownErrorPatch): Promise<KnownErrorDetail> {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'problem') throw new ValidationError('Not a problem record');
  requireAction(ctx, t, 'problems:manage');
  const [before] = await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1);
  // Flagging has one entry point, `updateProblemDetails` (it also moves the ticket to Known Error); an unflagged problem has no entry here.
  if (!before?.isKnownError) throw new NotFoundError('Known error');
  const fix = await resolveFixChange(ctx, t, patch);
  const now = new Date();
  const values: Partial<typeof schema.problemDetails.$inferInsert> = {};
  // The flag was just set (or predates the lifecycle columns): stamp the identification date and open the lifecycle.
  const first = !before.keIdentifiedAt;
  if (first) {
    values.keIdentifiedAt = now;
    values.keStatus = patch.keStatus ?? before.keStatus ?? 'open';
    values.keStatusAt = now;
  } else if (patch.keStatus !== undefined && patch.keStatus !== (before.keStatus ?? 'open')) {
    values.keStatus = patch.keStatus;
    values.keStatusAt = now;
  }
  if (fix !== undefined) values.fixChangeId = fix?.id ?? null;
  if (patch.customerSummary !== undefined) values.customerSummary = patch.customerSummary;
  if (patch.customerWorkaround !== undefined) values.customerWorkaround = patch.customerWorkaround;
  const changes = diffChanges(before as Record<string, unknown>, values as Record<string, unknown>);
  if (Object.keys(changes).length) {
    values.updatedAt = now;
    await ctx.tx.update(schema.problemDetails).set(values).where(eq(schema.problemDetails.ticketId, t.id));
    await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'known_error.update', customerId: t.customerId, changes });
    const status = values.keStatus ?? before.keStatus ?? 'open';
    const parts: string[] = [];
    if (changes.keStatus || changes.keIdentifiedAt) parts.push(`Known error status: ${KNOWN_ERROR_STATUS_LABELS[asKeStatus(status)]}${fix ? ` (${fix.number})` : ''}`);
    else if (changes.fixChangeId) parts.push(fix ? `Permanent fix: ${fix.number} (${fix.title})` : 'Permanent fix change cleared');
    if (changes.customerSummary || changes.customerWorkaround) parts.push('customer-facing wording updated');
    await addActivity(ctx, t, { type: 'known_error', summary: parts.join('; ') || 'Known error updated', data: { fields: Object.keys(changes), keStatus: status, fixChangeId: values.fixChangeId ?? before.fixChangeId ?? null }, customerVisible: false });
  }
  return getKnownError(ctx, t.id);
}

export const setKnownErrorStatus = (ctx: Ctx, ticketId: string, status: KnownErrorStatus) => updateKnownError(ctx, ticketId, { keStatus: status });

/** The organisation's active portal users whose role grants portal:kedb: the ones who can open the page the notice links to. */
export async function portalRecipients(tx: Tx, customerId: string): Promise<Recipient[]> {
  const rows = await tx
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.userType, 'customer'),
        eq(schema.users.customerId, customerId),
        eq(schema.users.status, 'active'),
        sql`EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ${schema.users.id} AND rp.permission = 'portal:kedb')`,
      ),
    );
  return rows.map((u) => ({ userId: u.id, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: u.whatsappOptIn }));
}

/** Publishes (or re-words) a known error for the customer's portal; the organisation's portal users are told the first time. */
export async function publishKnownError(ctx: Ctx, ticketId: string, body: PublishBody): Promise<KnownErrorDetail & { notified: number; first: boolean }> {
  const t = await loadTicket(ctx, ticketId);
  if (t.type !== 'problem') throw new NotFoundError('Known error');
  requireAction(ctx, t, 'kedb:publish');
  // Row lock: two publishes racing on the same entry serialise here, so only the first one notifies.
  const [before] = await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1).for('update');
  if (!before?.isKnownError) throw new ValidationError('Flag the problem as a known error first');
  if ((before.keStatus ?? 'open') === 'retired') throw new ValidationError('A retired known error cannot be published; reopen it first');
  const now = new Date();
  const first = !before.portalVisible;
  await ctx.tx
    .update(schema.problemDetails)
    .set({ customerSummary: body.customerSummary, customerWorkaround: body.customerWorkaround, portalVisible: true, publishedAt: first || !before.publishedAt ? now : before.publishedAt, publishedBy: userIdOf(ctx) ?? before.publishedBy, updatedAt: now })
    .where(eq(schema.problemDetails.ticketId, t.id));
  let notified = 0;
  const settings = await loadKedbSettings(ctx.tx);
  if (first && body.notify !== false && settings.notifyCustomers) {
    const recipients = await portalRecipients(ctx.tx, t.customerId);
    if (recipients.length) {
      const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
      const [svc] = t.serviceId ? await ctx.tx.select({ name: schema.services.name }).from(schema.services).where(eq(schema.services.id, t.serviceId)).limit(1) : [];
      await queueNotification(ctx.tx, {
        event: 'known_error.published',
        recipients,
        customerId: t.customerId,
        channels: ['email', 'in_app', 'whatsapp'],
        entityType: 'known_error',
        entityId: t.id,
        link: `/knowledge/known-errors/${t.id}`,
        title: `Known issue: ${t.title}`,
        body: body.customerWorkaround,
        data: { knownError: { number: t.number, title: t.title, customerName: cust?.name ?? '', service: svc?.name ?? null, summary: body.customerSummary, workaround: body.customerWorkaround, link: `${config.APP_URL.replace(/\/$/, '')}/knowledge/known-errors/${t.id}` } },
      });
      notified = recipients.length;
    }
  }
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'known_error.publish', customerId: t.customerId, metadata: { notified, first }, changes: diffChanges(before as Record<string, unknown>, { customerSummary: body.customerSummary, customerWorkaround: body.customerWorkaround, portalVisible: true }) });
  await addActivity(ctx, t, { type: 'known_error', summary: first ? 'Published to the customer portal' : 'Customer portal wording updated', data: { notified, first }, customerVisible: true });
  return { ...(await getKnownError(ctx, t.id)), notified, first };
}

export async function unpublishKnownError(ctx: Ctx, ticketId: string): Promise<KnownErrorDetail> {
  const { t, pd } = await loadKnownErrorTicket(ctx, ticketId);
  requireAction(ctx, t, 'kedb:publish');
  if (pd.portalVisible) {
    await ctx.tx.update(schema.problemDetails).set({ portalVisible: false, updatedAt: new Date() }).where(eq(schema.problemDetails.ticketId, t.id));
    await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'known_error.unpublish', customerId: t.customerId, changes: { portalVisible: { old: true, new: false } } });
    await addActivity(ctx, t, { type: 'known_error', summary: 'Withdrawn from the customer portal', customerVisible: false });
  }
  return getKnownError(ctx, t.id);
}

const FAILED_STATUS = /\b(fail|back(ed)?[ -]?out|roll(ed)?[ -]?back|abort|unsuccessful)/i;
/** The seeded "Failed / Backed Out" status (key `failed`) and any custom status worded like it did not deliver the fix. */
const changeLanded = (status: { key: string; label: string }) => status.key !== 'failed' && !FAILED_STATUS.test(status.label);

/**
 * Called from `changeStatusCore` when a change reaches a resolved status: the
 * known errors waiting on that change move to resolved (when the setting is
 * on). The actor already passed the change's own permission check and the
 * problems belong to the same customer, so the rows are read with a plain select.
 */
export async function onChangeImplemented(ctx: Ctx, change: TicketRow) {
  if (change.type !== 'change') return;
  // The status category "resolved" also covers a failed or backed-out change; only a change that landed resolves the known error.
  const status = await optionById(ctx.tx, change.statusId);
  if (!status || status.statusCategory !== 'resolved' || !changeLanded(status)) return;
  if (!(await loadKedbSettings(ctx.tx)).resolveOnFix) return;
  const rows = await ctx.tx
    .select({ id: schema.tickets.id, number: schema.tickets.number, customerId: schema.tickets.customerId, keStatus: schema.problemDetails.keStatus })
    .from(schema.problemDetails)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.problemDetails.ticketId))
    .where(and(eq(schema.problemDetails.fixChangeId, change.id), eq(schema.problemDetails.isKnownError, true), sql`coalesce(${schema.problemDetails.keStatus}, 'open') IN ('open', 'fix_in_progress')`));
  const now = new Date();
  for (const p of rows) {
    await ctx.tx.update(schema.problemDetails).set({ keStatus: 'resolved', keStatusAt: now, updatedAt: now }).where(eq(schema.problemDetails.ticketId, p.id));
    await ctx.audit({ entityType: 'ticket', entityId: p.id, entityLabel: p.number, action: 'known_error.resolve_on_fix', customerId: p.customerId, changes: { keStatus: { old: p.keStatus ?? 'open', new: 'resolved' } }, metadata: { changeId: change.id, changeNumber: change.number } });
    await addActivity(ctx, { id: p.id, customerId: p.customerId }, { type: 'known_error', summary: `Permanent fix implemented by ${change.number}; known error resolved`, data: { changeId: change.id, changeNumber: change.number }, customerVisible: false });
  }
  return rows.length;
}

// ---------------------------------------------------------------- portal reads (own organisation, published entries, customer wording only)

const PORTAL_COLS = sql`t.id, t.number, t.title, ${KE_STATUS} AS "keStatus", pd.customer_summary AS summary, pd.customer_workaround AS workaround, t.service_id AS "serviceId", sv.name AS "serviceName", pd.published_at AS "publishedAt", greatest(pd.updated_at, t.updated_at) AS "updatedAt"`;
const PORTAL_FROM = sql`FROM tickets t JOIN problem_details pd ON pd.ticket_id = t.id LEFT JOIN services sv ON sv.id = t.service_id`;
const portalBase = (customerId: string): SQL[] => [sql`t.type = 'problem'`, sql`pd.is_known_error`, sql`pd.portal_visible`, sql`t.customer_id = ${customerId}::uuid`, sql`${KE_STATUS} <> 'retired'`];
const portalSearch = (term: string) => sql`(to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(pd.customer_summary, '') || ' ' || coalesce(pd.customer_workaround, '')) @@ websearch_to_tsquery('simple', ${term}) OR similarity(t.title, ${term}) > 0.25)`;

/** Built field by field: never `...row`. */
const toPortal = (r: Row): PortalKnownError => ({
  id: String(r.id),
  number: String(r.number),
  title: String(r.title),
  keStatus: asKeStatus(r.keStatus),
  summary: (r.summary as string | null) ?? null,
  workaround: (r.workaround as string | null) ?? null,
  service: r.serviceId ? { id: String(r.serviceId), name: String(r.serviceName ?? '') } : null,
  publishedAt: asDate(r.publishedAt),
  updatedAt: asDate(r.updatedAt) ?? new Date(),
});

async function portalRowOf(ctx: Ctx, customerId: string, ticketId: string): Promise<PortalKnownError | null> {
  const raw = (await ctx.tx.execute(sql`SELECT ${PORTAL_COLS} ${PORTAL_FROM} WHERE ${sql.join([...portalBase(customerId), sql`t.id = ${ticketId}::uuid`], sql` AND `)} LIMIT 1`)).rows as Row[];
  return raw[0] ? toPortal(raw[0]) : null;
}

export async function listPortalKnownErrors(ctx: Ctx, q: PortalListQuery): Promise<{ items: PortalKnownError[]; total: number; page: number; pageSize: number; services: { id: string; name: string }[] }> {
  const scope = resolvePortalCustomer(ctx, 'portal:kedb', q.customerId);
  const conds = portalBase(scope.customerId);
  if (q.status === 'active') conds.push(ACTIVE);
  else if (q.status === 'resolved') conds.push(sql`${KE_STATUS} = 'resolved'`);
  const term = q.q?.trim();
  if (term) conds.push(portalSearch(term));
  if (q.serviceId) conds.push(sql`t.service_id = ${q.serviceId}::uuid`);
  const where = sql.join(conds, sql` AND `);
  const { limit, offset } = limitOffset(q);
  const [count] = (await ctx.tx.execute(sql`SELECT count(*)::int AS n ${PORTAL_FROM} WHERE ${where}`)).rows as { n: number }[];
  const raw = (await ctx.tx.execute(sql`SELECT ${PORTAL_COLS} ${PORTAL_FROM} WHERE ${where} ORDER BY pd.published_at DESC NULLS LAST, t.updated_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows as Row[];
  const services = (await ctx.tx.execute(sql`SELECT DISTINCT sv.id, sv.name ${PORTAL_FROM} WHERE ${sql.join(portalBase(scope.customerId), sql` AND `)} AND sv.id IS NOT NULL ORDER BY sv.name`)).rows as { id: string; name: string }[];
  return { items: raw.map(toPortal), total: num(count?.n), page: q.page, pageSize: q.pageSize, services: services.map((s) => ({ id: String(s.id), name: String(s.name) })) };
}

/** An unpublished, retired or foreign entry answers 404 (never 403, so nothing leaks about its existence). */
export async function getPortalKnownError(ctx: Ctx, ticketId: string, requested?: string | null): Promise<PortalKnownError> {
  const scope = resolvePortalCustomer(ctx, 'portal:kedb', requested);
  const row = await portalRowOf(ctx, scope.customerId, ticketId);
  if (!row) throw new NotFoundError('Known error');
  return row;
}

export async function suggestPortalKnownErrors(ctx: Ctx, q: PortalSuggestQuery): Promise<{ items: PortalKnownError[] }> {
  const scope = resolvePortalCustomer(ctx, 'portal:kedb', q.customerId);
  const term = q.q.trim();
  if (term.length < 2) return { items: [] };
  const conds = [...portalBase(scope.customerId), ACTIVE, sql`(to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(pd.customer_summary, '') || ' ' || coalesce(pd.customer_workaround, '')) @@ plainto_tsquery('simple', ${term}) OR similarity(t.title, ${term}) > 0.2)`];
  const limit = Math.min(10, Math.max(1, q.limit ?? (await loadKedbSettings(ctx.tx)).suggestLimit));
  const score = sql`(ts_rank(to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(pd.customer_summary, '') || ' ' || coalesce(pd.customer_workaround, '')), plainto_tsquery('simple', ${term})) + similarity(t.title, ${term})
    + CASE WHEN ${q.serviceId ?? null}::uuid IS NOT NULL AND t.service_id = ${q.serviceId ?? null}::uuid THEN 0.5 ELSE 0 END)`;
  const raw = (await ctx.tx.execute(sql`SELECT ${PORTAL_COLS}, ${score} AS score ${PORTAL_FROM} WHERE ${sql.join(conds, sql` AND `)} ORDER BY score DESC, pd.published_at DESC NULLS LAST LIMIT ${limit}`)).rows as Row[];
  return { items: raw.filter((r) => Number(r.score) > 0).map(toPortal) };
}
