import { eq, and, desc, inArray, sql, lt, or, isNull, ilike } from 'drizzle-orm';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { config } from '@/config';
import { queueNotification, type NotificationChannel } from '@/modules/notifications/dispatch';
import { loadTicket, loadTicketByNumber, requireAction, addActivity, reloadTicket, userIdOf, optionMap, toLabel, type TicketRow } from './common';
import { notifyTicketEvent, ticketLink, type RecipientFlags } from './notify';

/**
 * Major incident management. Declaring turns an incident into a programme: a bridge,
 * a commander and a communications lead, stakeholder updates on a cadence (with a
 * reminder when one is overdue), child incidents and a post-incident review.
 */

export type MajorRow = typeof schema.majorIncidents.$inferSelect;
export type MajorUpdateRow = typeof schema.majorIncidentUpdates.$inferSelect;

/** Who hears about stakeholder updates unless the sender chooses otherwise. */
export const DEFAULT_AUDIENCE: RecipientFlags = { requester: true, watchers: true, customerContacts: true, accountManager: true };
export const DEFAULT_CHANNELS: NotificationChannel[] = ['email', 'in_app', 'whatsapp'];
/** Who hears that a major incident was declared when no notification rule says otherwise. */
const DECLARED_AUDIENCE: RecipientFlags = { assignee: true, team: true, manager: true, accountManager: true, roles: ['noc_manager', 'soc_manager', 'service_manager'] };

export interface DeclareInput {
  reason?: string | null;
  bridgeUrl?: string | null;
  commanderUserId?: string | null;
  commsLeadUserId?: string | null;
  portalBanner?: boolean;
  updateIntervalMinutes?: number;
  /** Skip the declared notification (ticket creation already notifies). */
  notify?: boolean;
}

export interface MajorPatch {
  bridgeUrl?: string | null;
  bridgeNotes?: string | null;
  commanderUserId?: string | null;
  commsLeadUserId?: string | null;
  portalBanner?: boolean;
  updateIntervalMinutes?: number;
  pirWhatHappened?: string | null;
  pirImpact?: string | null;
  pirRootCause?: string | null;
  pirActions?: MajorRow['pirActions'];
  status?: 'active' | 'resolved' | 'review_done';
}

export interface MajorUpdateInput {
  body: string;
  kind?: 'stakeholder' | 'internal';
  audience?: RecipientFlags;
  channels?: NotificationChannel[];
  portalBanner?: boolean;
}

const nextDue = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000);

async function majorRow(tx: Tx, ticketId: string): Promise<MajorRow | null> {
  const [row] = await tx.select().from(schema.majorIncidents).where(eq(schema.majorIncidents.ticketId, ticketId)).limit(1);
  return row ?? null;
}

async function requireMspUser(ctx: Ctx, id: string | null | undefined, label: string) {
  if (!id) return;
  const [u] = await ctx.tx.select({ id: schema.users.id, userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!u || u.userType !== 'msp' || u.status !== 'active') throw new ValidationError(`${label} must be an active staff member`);
}

/** Creates or re-activates the major record for a ticket and flags the ticket. Used by declare and by ticket creation. */
export async function declareCore(ctx: Ctx, ticket: TicketRow, input: DeclareInput = {}): Promise<MajorRow> {
  if (ticket.type !== 'incident') throw new ValidationError('Only incidents can be declared major');
  await requireMspUser(ctx, input.commanderUserId, 'Incident commander');
  await requireMspUser(ctx, input.commsLeadUserId, 'Communications lead');
  const now = new Date();
  const existing = await majorRow(ctx.tx, ticket.id);
  const interval = input.updateIntervalMinutes ?? existing?.updateIntervalMinutes ?? 30;
  const values = {
    customerId: ticket.customerId,
    status: 'active',
    declaredBy: userIdOf(ctx),
    declaredAt: now,
    demotedAt: null,
    resolvedAt: null,
    bridgeUrl: input.bridgeUrl ?? existing?.bridgeUrl ?? null,
    commanderUserId: input.commanderUserId ?? existing?.commanderUserId ?? ticket.assigneeId ?? userIdOf(ctx),
    commsLeadUserId: input.commsLeadUserId ?? existing?.commsLeadUserId ?? null,
    portalBanner: input.portalBanner ?? existing?.portalBanner ?? true,
    updateIntervalMinutes: interval,
    nextUpdateDueAt: nextDue(now, interval),
    lastReminderAt: null,
    updatedAt: now,
  };
  const [row] = existing
    ? await ctx.tx.update(schema.majorIncidents).set(values).where(eq(schema.majorIncidents.ticketId, ticket.id)).returning()
    : await ctx.tx.insert(schema.majorIncidents).values({ ticketId: ticket.id, ...values }).returning();
  await ctx.tx.update(schema.tickets).set({ isMajor: true, updatedAt: now, updatedBy: userIdOf(ctx), lastActivityAt: now }).where(eq(schema.tickets.id, ticket.id));
  await addActivity(ctx, ticket, { type: 'major', summary: `Declared a major incident${input.reason ? `: ${input.reason}` : ''}`, data: { reason: input.reason ?? null, reactivated: !!existing }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ticket.major_declare', customerId: ticket.customerId, metadata: { reason: input.reason ?? null } });
  if (input.notify !== false) {
    const fresh = await reloadTicket(ctx.tx, ticket.id);
    await notifyTicketEvent(ctx, 'incident.major_declared', fresh, { reason: input.reason ?? null, recipientFallback: DECLARED_AUDIENCE, channels: DEFAULT_CHANNELS });
  }
  return row!;
}

export async function declareMajor(ctx: Ctx, id: string, input: DeclareInput = {}) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:major');
  const [status] = await ctx.tx.select({ category: schema.configOptions.statusCategory }).from(schema.configOptions).where(eq(schema.configOptions.id, t.statusId)).limit(1);
  if (status?.category === 'closed' || status?.category === 'cancelled') throw new ValidationError('A closed ticket cannot be declared a major incident');
  const existing = await majorRow(ctx.tx, t.id);
  if (existing?.status === 'active' && t.isMajor) throw new ValidationError('This ticket is already a major incident');
  await declareCore(ctx, t, input);
  return getMajor(ctx, id);
}

/** "Not a major incident after all": keeps the record for the audit trail but drops the flag and the banner. */
export async function demoteMajor(ctx: Ctx, id: string, input: { reason?: string | null } = {}) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:major');
  const existing = await majorRow(ctx.tx, t.id);
  if (!existing || !t.isMajor) throw new ValidationError('This ticket is not a major incident');
  const now = new Date();
  await ctx.tx.update(schema.majorIncidents).set({ status: 'demoted', demotedAt: now, portalBanner: false, nextUpdateDueAt: null, updatedAt: now }).where(eq(schema.majorIncidents.ticketId, t.id));
  await ctx.tx.update(schema.tickets).set({ isMajor: false, updatedAt: now, updatedBy: userIdOf(ctx), lastActivityAt: now }).where(eq(schema.tickets.id, t.id));
  await addActivity(ctx, t, { type: 'major', summary: `No longer a major incident${input.reason ? `: ${input.reason}` : ''}`, data: { reason: input.reason ?? null, demoted: true }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.major_demote', customerId: t.customerId, metadata: { reason: input.reason ?? null } });
  return getMajor(ctx, id);
}

async function userNames(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, string>();
  const rows = await tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The major incident record with its communication log and child incidents (null record when the ticket was never declared). */
export async function getMajor(ctx: Ctx, id: string) {
  const t = await loadTicket(ctx, id);
  const row = await majorRow(ctx.tx, t.id);
  if (!row) return { record: null, updates: [], children: [] };
  const names = await userNames(ctx.tx, [row.declaredBy, row.commanderUserId, row.commsLeadUserId, ...row.pirActions.map((a) => a.ownerId)]);
  const updates = await ctx.tx.select().from(schema.majorIncidentUpdates).where(eq(schema.majorIncidentUpdates.ticketId, t.id)).orderBy(desc(schema.majorIncidentUpdates.createdAt));
  const childRows = await ctx.tx
    .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, statusId: schema.tickets.statusId, priorityId: schema.tickets.priorityId, createdAt: schema.tickets.createdAt, linkId: schema.ticketLinks.id })
    .from(schema.ticketLinks)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketLinks.sourceTicketId))
    .where(and(eq(schema.ticketLinks.targetTicketId, t.id), eq(schema.ticketLinks.linkType, 'child_of')))
    .orderBy(desc(schema.tickets.createdAt));
  const opts = await optionMap(ctx.tx, childRows.flatMap((c) => [c.statusId, c.priorityId]));
  const now = Date.now();
  return {
    record: {
      ...row,
      declaredByName: names.get(row.declaredBy ?? '') ?? null,
      commanderName: names.get(row.commanderUserId ?? '') ?? null,
      commsLeadName: names.get(row.commsLeadUserId ?? '') ?? null,
      pirActions: row.pirActions.map((a) => ({ ...a, ownerName: a.ownerId ? (names.get(a.ownerId) ?? a.ownerName ?? null) : null })),
      overdue: row.status === 'active' && !!row.nextUpdateDueAt && row.nextUpdateDueAt.getTime() < now,
    },
    updates: updates.filter((u) => u.kind === 'stakeholder' || !ctx.user.isSystem),
    children: childRows.map((c) => ({ id: c.id, number: c.number, title: c.title, status: toLabel(opts.get(c.statusId)), priority: toLabel(opts.get(c.priorityId ?? '')), createdAt: c.createdAt, linkId: c.linkId })),
  };
}

export async function updateMajor(ctx: Ctx, id: string, patch: MajorPatch) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:major');
  const existing = await majorRow(ctx.tx, t.id);
  if (!existing) throw new NotFoundError('Major incident');
  await requireMspUser(ctx, patch.commanderUserId, 'Incident commander');
  await requireMspUser(ctx, patch.commsLeadUserId, 'Communications lead');
  const now = new Date();
  const values: Partial<typeof schema.majorIncidents.$inferInsert> = { updatedAt: now };
  for (const k of ['bridgeUrl', 'bridgeNotes', 'commanderUserId', 'commsLeadUserId', 'portalBanner', 'updateIntervalMinutes', 'pirWhatHappened', 'pirImpact', 'pirRootCause', 'pirActions'] as const) {
    if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.updateIntervalMinutes !== undefined && existing.status === 'active') values.nextUpdateDueAt = nextDue(existing.lastUpdateAt ?? existing.declaredAt, patch.updateIntervalMinutes);
  if (patch.status && patch.status !== existing.status) {
    values.status = patch.status;
    if (patch.status === 'review_done') values.pirCompletedAt = now;
    if (patch.status === 'resolved') {
      values.resolvedAt = existing.resolvedAt ?? now;
      values.nextUpdateDueAt = null;
    }
    if (patch.status === 'active') {
      values.resolvedAt = null;
      values.pirCompletedAt = null;
      values.nextUpdateDueAt = nextDue(now, patch.updateIntervalMinutes ?? existing.updateIntervalMinutes);
      if (!t.isMajor) await ctx.tx.update(schema.tickets).set({ isMajor: true, updatedAt: now }).where(eq(schema.tickets.id, t.id));
    }
  }
  await ctx.tx.update(schema.majorIncidents).set(values).where(eq(schema.majorIncidents.ticketId, t.id));
  const changed = Object.keys(values).filter((k) => k !== 'updatedAt');
  const summary = patch.status === 'review_done' ? 'Post-incident review completed' : patch.status === 'resolved' ? 'Major incident marked resolved' : patch.status === 'active' ? 'Major incident re-opened' : `Major incident details updated (${changed.map((k) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')})`;
  await addActivity(ctx, t, { type: 'major', summary, data: { fields: changed }, customerVisible: patch.status !== undefined });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.major_update', customerId: t.customerId, metadata: { fields: changed } });
  return getMajor(ctx, id);
}

/** A stakeholder update goes to the chosen audience over the chosen channels; an internal note only joins the log. */
export async function postMajorUpdate(ctx: Ctx, id: string, input: MajorUpdateInput) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:major');
  const existing = await majorRow(ctx.tx, t.id);
  if (!existing || existing.status === 'demoted') throw new ValidationError('This ticket is not a major incident');
  const kind = input.kind ?? 'stakeholder';
  const audience = input.audience ?? DEFAULT_AUDIENCE;
  const channels = input.channels?.length ? input.channels : DEFAULT_CHANNELS;
  const now = new Date();
  const [row] = await ctx.tx
    .insert(schema.majorIncidentUpdates)
    .values({ ticketId: t.id, customerId: t.customerId, authorId: userIdOf(ctx), authorName: ctx.user.name, kind, body: input.body, audience: kind === 'stakeholder' ? (audience as Record<string, unknown>) : {}, channels: kind === 'stakeholder' ? channels : [], portalBanner: kind === 'stakeholder' ? (input.portalBanner ?? existing.portalBanner) : false, createdAt: now })
    .returning();
  const values: Partial<typeof schema.majorIncidents.$inferInsert> = { updatedAt: now };
  if (kind === 'stakeholder') {
    values.lastUpdateAt = now;
    values.nextUpdateDueAt = existing.status === 'active' ? nextDue(now, existing.updateIntervalMinutes) : null;
    values.lastReminderAt = null;
    if (input.portalBanner !== undefined) values.portalBanner = input.portalBanner;
  }
  await ctx.tx.update(schema.majorIncidents).set(values).where(eq(schema.majorIncidents.ticketId, t.id));
  const excerpt = input.body.length > 240 ? `${input.body.slice(0, 239)}…` : input.body;
  await addActivity(ctx, t, { type: 'major_update', summary: kind === 'stakeholder' ? `Stakeholder update: ${excerpt}` : `Bridge note: ${excerpt}`, data: { updateId: row!.id, kind }, customerVisible: kind === 'stakeholder' });
  let sentCount = 0;
  if (kind === 'stakeholder') {
    sentCount = await notifyTicketEvent(ctx, 'incident.major_update', await reloadTicket(ctx.tx, t.id), { comment: input.body, recipientOverride: audience, channels });
    await ctx.tx.update(schema.majorIncidentUpdates).set({ sentCount }).where(eq(schema.majorIncidentUpdates.id, row!.id));
  }
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.major_update_posted', customerId: t.customerId, metadata: { updateId: row!.id, kind, sentCount, channels } });
  return { ...row!, sentCount };
}

/** Links another incident as a child of this major incident (child → parent, link type child_of). */
export async function addChild(ctx: Ctx, id: string, input: { ticketId?: string; number?: string }) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:major');
  if (!t.isMajor) throw new ValidationError('This ticket is not a major incident');
  const child = input.ticketId ? await loadTicket(ctx, input.ticketId) : await loadTicketByNumber(ctx, input.number ?? '');
  if (child.id === t.id) throw new ValidationError('A ticket cannot be its own child');
  const { addLink } = await import('./activity');
  await addLink(ctx, child.id, { targetTicketId: t.id, linkType: 'child_of' });
  return getMajor(ctx, id);
}

/** Keeps the major record in step with the ticket's status (called from the status engine). */
export async function syncMajorOnStatus(ctx: Ctx, ticket: TicketRow, toCategory: string | null, fromCategory: string | null, resolutionNotes?: string | null) {
  const existing = await majorRow(ctx.tx, ticket.id);
  if (!existing || existing.status === 'demoted') return;
  const now = new Date();
  if ((toCategory === 'resolved' || toCategory === 'closed' || toCategory === 'cancelled') && existing.status === 'active') {
    await ctx.tx.update(schema.majorIncidents).set({ status: 'resolved', resolvedAt: now, nextUpdateDueAt: null, updatedAt: now }).where(eq(schema.majorIncidents.ticketId, ticket.id));
    if (toCategory !== 'cancelled') await notifyTicketEvent(ctx, 'incident.major_resolved', ticket, { comment: resolutionNotes ?? null, recipientFallback: DEFAULT_AUDIENCE, channels: DEFAULT_CHANNELS });
  } else if ((fromCategory === 'resolved' || fromCategory === 'closed') && toCategory !== 'resolved' && toCategory !== 'closed' && toCategory !== 'cancelled' && existing.status === 'resolved') {
    await ctx.tx.update(schema.majorIncidents).set({ status: 'active', resolvedAt: null, nextUpdateDueAt: nextDue(now, existing.updateIntervalMinutes), updatedAt: now }).where(eq(schema.majorIncidents.ticketId, ticket.id));
  }
}

export interface MajorListQuery {
  status?: 'active' | 'resolved' | 'review_done' | 'demoted' | 'all';
  customerId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Major incidents across customers (RLS limits the rows to the caller's customers), active first. */
export async function listMajor(ctx: Ctx, query: MajorListQuery = {}) {
  ctx.require('tickets:read');
  const m = schema.majorIncidents;
  const t = schema.tickets;
  const conds = [];
  const status = query.status ?? 'active';
  if (status !== 'all') conds.push(eq(m.status, status));
  if (query.customerId) conds.push(eq(m.customerId, query.customerId));
  if (query.q?.trim()) conds.push(or(ilike(t.number, `%${query.q.trim()}%`), ilike(t.title, `%${query.q.trim()}%`)));
  if (!ctx.can('soc:read')) conds.push(sql`${t.domain} <> 'soc'`);
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const commander = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${m.commanderUserId})`;
  const commsLead = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${m.commsLeadUserId})`;
  const rows = await ctx.tx
    .select({
      ticketId: m.ticketId,
      number: t.number,
      title: t.title,
      customerId: t.customerId,
      customerName: schema.customers.name,
      status: m.status,
      statusId: t.statusId,
      priorityId: t.priorityId,
      declaredAt: m.declaredAt,
      resolvedAt: m.resolvedAt,
      lastUpdateAt: m.lastUpdateAt,
      nextUpdateDueAt: m.nextUpdateDueAt,
      bridgeUrl: m.bridgeUrl,
      portalBanner: m.portalBanner,
      commanderName: commander,
      commsLeadName: commsLead,
      updatesCount: sql<number>`(SELECT count(*)::int FROM major_incident_updates u WHERE u.ticket_id = ${m.ticketId} AND u.kind = 'stakeholder')`,
      childrenCount: sql<number>`(SELECT count(*)::int FROM ticket_links l WHERE l.target_ticket_id = ${m.ticketId} AND l.link_type = 'child_of')`,
    })
    .from(m)
    .innerJoin(t, eq(t.id, m.ticketId))
    .innerJoin(schema.customers, eq(schema.customers.id, t.customerId))
    .where(where)
    .orderBy(sql`CASE ${m.status} WHEN 'active' THEN 0 WHEN 'resolved' THEN 1 WHEN 'review_done' THEN 2 ELSE 3 END`, desc(m.declaredAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ total }] = await ctx.tx.select({ total: sql<number>`count(*)::int` }).from(m).innerJoin(t, eq(t.id, m.ticketId)).where(where);
  const [summary] = await ctx.tx
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${m.status} = 'active')::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${m.status} = 'active' AND ${m.nextUpdateDueAt} < now())::int`,
      awaitingReview: sql<number>`count(*) FILTER (WHERE ${m.status} = 'resolved')::int`,
      resolved30d: sql<number>`count(*) FILTER (WHERE ${m.resolvedAt} >= now() - interval '30 days')::int`,
    })
    .from(m)
    .innerJoin(t, eq(t.id, m.ticketId))
    .where(ctx.can('soc:read') ? undefined : sql`${t.domain} <> 'soc'`);
  const opts = await optionMap(ctx.tx, rows.flatMap((r) => [r.statusId, r.priorityId]));
  const now = Date.now();
  return {
    items: rows.map((r) => ({ ...r, ticketStatus: toLabel(opts.get(r.statusId)), priority: toLabel(opts.get(r.priorityId ?? '')), overdue: r.status === 'active' && !!r.nextUpdateDueAt && r.nextUpdateDueAt.getTime() < now })),
    total,
    page,
    pageSize,
    summary: { active: summary?.active ?? 0, overdue: summary?.overdue ?? 0, awaitingReview: summary?.awaitingReview ?? 0, resolved30d: summary?.resolved30d ?? 0 },
  };
}

/** Job: when a stakeholder update is overdue, remind the communications lead (or the commander) once per missed slot. */
export async function remindOverdueUpdates() {
  let reminded = 0;
  await withSystem(async (tx) => {
    const m = schema.majorIncidents;
    const due = await tx
      .select({ row: m, number: schema.tickets.number, title: schema.tickets.title, assigneeId: schema.tickets.assigneeId, customerId: schema.tickets.customerId })
      .from(m)
      .innerJoin(schema.tickets, eq(schema.tickets.id, m.ticketId))
      .where(and(eq(m.status, 'active'), lt(m.nextUpdateDueAt, new Date()), or(isNull(m.lastReminderAt), sql`${m.lastReminderAt} < ${m.nextUpdateDueAt}`)));
    for (const d of due) {
      const targetId = d.row.commsLeadUserId ?? d.row.commanderUserId ?? d.assigneeId;
      if (!targetId) continue;
      const [u] = await tx.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn }).from(schema.users).where(and(eq(schema.users.id, targetId), eq(schema.users.status, 'active'))).limit(1);
      if (!u) continue;
      const minutes = Math.round((Date.now() - d.row.nextUpdateDueAt!.getTime()) / 60_000);
      await queueNotification(tx, {
        event: 'incident.major_update_due',
        recipients: [{ userId: u.id, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: u.whatsappOptIn }],
        data: { ticket: { number: d.number, title: d.title, link: ticketLink(d.row.ticketId) }, minutesOverdue: minutes, intervalMinutes: d.row.updateIntervalMinutes, platformName: 'Progression', appUrl: config.APP_URL },
        customerId: d.customerId,
        channels: ['in_app', 'email', 'whatsapp'],
        entityType: 'ticket',
        entityId: d.row.ticketId,
        link: `/tickets/${d.row.ticketId}?tab=major`,
        title: `${d.number}: stakeholder update overdue by ${minutes} min`,
        body: `The next update on major incident ${d.number} "${d.title}" was due ${minutes} minutes ago.`,
      });
      await tx.update(m).set({ lastReminderAt: new Date() }).where(eq(m.ticketId, d.row.ticketId));
      reminded++;
    }
  });
  return reminded;
}
