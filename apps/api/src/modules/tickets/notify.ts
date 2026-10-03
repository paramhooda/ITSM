import { eq, and, inArray, or, isNull } from 'drizzle-orm';
import type { NotificationEvent } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { config } from '@/config';
import { queueNotification, type Recipient, type NotificationChannel } from '@/modules/notifications/dispatch';
import { logger } from '@/core/logger';
import { TYPE_LABEL, type TicketRow, isSystemCtx } from './common';

/** Recipient flags as stored in `notification_rules.recipients`. */
export interface RecipientFlags {
  requester?: boolean;
  assignee?: boolean;
  team?: boolean;
  watchers?: boolean;
  manager?: boolean;
  customerContacts?: boolean;
  approvers?: boolean;
  accountManager?: boolean;
  /** Whoever the assigned team's rotas put on call right now. */
  onCall?: boolean;
  roles?: string[];
  users?: string[];
  emails?: string[];
}

export interface NotifyExtra {
  comment?: string | null;
  previousStatus?: string | null;
  level?: number | null;
  reason?: string | null;
  sla?: { metric: string; dueAt: Date | null; pct: number } | null;
  /** Additional recipients (e.g. escalation rule targets). */
  extraRecipients?: Recipient[];
  /** Replace rule-based recipients entirely (escalation rule actions). */
  recipientOverride?: RecipientFlags;
  /** Used only when no active notification rule exists for the event (features with a sensible default audience). */
  recipientFallback?: RecipientFlags;
  /** Channels override (defaults to the union of matching rules, or email+in_app). */
  channels?: NotificationChannel[];
  /** Users who must not be notified in addition to the actor. */
  excludeUserIds?: string[];
}

interface UserLite {
  id: string;
  email: string;
  name: string;
  userType: 'msp' | 'customer';
  phone: string | null;
  whatsappOptIn: boolean;
}

const USER_LITE = { id: schema.users.id, email: schema.users.email, name: schema.users.name, userType: schema.users.userType, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn };
const CONTACT_LITE = { email: schema.contacts.email, name: schema.contacts.name, userId: schema.contacts.userId, phone: schema.contacts.phone, mobile: schema.contacts.mobile, whatsappOptIn: schema.contacts.whatsappOptIn };
const contactRecipient = (c: { email: string | null; name: string; phone: string | null; mobile: string | null; whatsappOptIn: boolean }): Recipient => ({ email: c.email, name: c.name, phone: c.mobile ?? c.phone, whatsappOptIn: c.whatsappOptIn });

const appUrl = () => config.APP_URL.replace(/\/$/, '');
export const ticketLink = (ticketId: string, portal = false) => `${appUrl()}${portal ? '/portal/tickets/' : '/tickets/'}${ticketId}`;

async function usersByIds(tx: Tx, ids: string[]): Promise<UserLite[]> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return [];
  return tx.select(USER_LITE).from(schema.users).where(and(inArray(schema.users.id, clean), eq(schema.users.status, 'active')));
}

async function usersWithRoles(tx: Tx, roleKeys: string[], customerId: string): Promise<UserLite[]> {
  if (!roleKeys.length) return [];
  const rows = await tx
    .select(USER_LITE)
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(inArray(schema.roles.key, roleKeys), or(isNull(schema.userRoles.customerId), eq(schema.userRoles.customerId, customerId)), eq(schema.users.status, 'active')));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

async function usersInTeams(tx: Tx, teamIds: string[]): Promise<UserLite[]> {
  const clean = [...new Set(teamIds.filter(Boolean))];
  if (!clean.length) return [];
  const rows = await tx
    .select(USER_LITE)
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
    .where(and(inArray(schema.teamMembers.teamId, clean), eq(schema.users.status, 'active')));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Resolves recipient flags against a ticket into concrete recipients (split by portal vs MSP link). */
export async function resolveRecipients(tx: Tx, ticket: TicketRow, flags: RecipientFlags): Promise<{ msp: Recipient[]; portal: Recipient[] }> {
  const userIds = new Set<string>();
  const portal: Recipient[] = [];
  const msp: Recipient[] = [];
  const users: UserLite[] = [];

  if (flags.requester) {
    if (ticket.requesterUserId) userIds.add(ticket.requesterUserId);
    if (ticket.requesterContactId) {
      const [c] = await tx.select(CONTACT_LITE).from(schema.contacts).where(eq(schema.contacts.id, ticket.requesterContactId)).limit(1);
      if (c?.userId) userIds.add(c.userId);
      else if (c?.email || (c?.whatsappOptIn && (c.mobile || c.phone))) portal.push(contactRecipient(c));
    }
    if (!ticket.requesterUserId && !ticket.requesterContactId && ticket.createdBy) userIds.add(ticket.createdBy);
  }
  if (flags.assignee && ticket.assigneeId) userIds.add(ticket.assigneeId);
  if (flags.team && ticket.assignedTeamId) users.push(...(await usersInTeams(tx, [ticket.assignedTeamId])));
  if (flags.watchers) {
    const rows = await tx.select({ userId: schema.ticketWatchers.userId }).from(schema.ticketWatchers).where(eq(schema.ticketWatchers.ticketId, ticket.id));
    rows.forEach((r) => userIds.add(r.userId));
  }
  if (flags.manager && ticket.assignedTeamId) {
    const [t] = await tx.select({ managerUserId: schema.teams.managerUserId }).from(schema.teams).where(eq(schema.teams.id, ticket.assignedTeamId)).limit(1);
    if (t?.managerUserId) userIds.add(t.managerUserId);
  }
  if (flags.onCall && ticket.assignedTeamId) {
    const { onCallUserIds } = await import('@/modules/oncall/service');
    (await onCallUserIds(tx, ticket.assignedTeamId)).forEach((id) => userIds.add(id));
  }
  if (flags.accountManager) {
    const [c] = await tx.select({ accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
    if (c?.accountManagerId) userIds.add(c.accountManagerId);
  }
  if (flags.customerContacts) {
    const rows = await tx
      .select(CONTACT_LITE)
      .from(schema.contacts)
      .where(and(eq(schema.contacts.customerId, ticket.customerId), eq(schema.contacts.isActive, true), or(eq(schema.contacts.isEscalation, true), eq(schema.contacts.isPrimary, true))));
    for (const c of rows) {
      if (c.userId) userIds.add(c.userId);
      else if (c.email || (c.whatsappOptIn && (c.mobile || c.phone))) portal.push(contactRecipient(c));
    }
  }
  if (flags.roles?.length) users.push(...(await usersWithRoles(tx, flags.roles, ticket.customerId)));
  if (flags.users?.length) flags.users.forEach((u) => userIds.add(u));
  if (flags.emails?.length) flags.emails.forEach((e) => msp.push({ email: e }));
  if (flags.approvers) {
    const pending = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending')));
    const roleKeys = pending.map((a) => a.approverRoleKey).filter((x): x is string => !!x);
    const teamIds = pending.map((a) => a.approverTeamId).filter((x): x is string => !!x);
    pending.forEach((a) => a.approverUserId && userIds.add(a.approverUserId));
    if (roleKeys.length) users.push(...(await usersWithRoles(tx, roleKeys, ticket.customerId)));
    if (teamIds.length) users.push(...(await usersInTeams(tx, teamIds)));
  }
  users.push(...(await usersByIds(tx, [...userIds])));

  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    const rcpt: Recipient = { userId: u.id, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: u.whatsappOptIn };
    if (u.userType === 'customer') portal.push(rcpt);
    else msp.push(rcpt);
  }
  return { msp, portal };
}

async function templateData(tx: Tx, ticket: TicketRow, actorName: string, extra: NotifyExtra, portal: boolean) {
  const ids = [ticket.statusId, ticket.priorityId].filter((x): x is string => !!x);
  const opts = ids.length ? await tx.select({ id: schema.configOptions.id, label: schema.configOptions.label }).from(schema.configOptions).where(inArray(schema.configOptions.id, ids)) : [];
  const label = (id: string | null) => opts.find((o) => o.id === id)?.label ?? '';
  const [customer] = await tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  const [service] = ticket.serviceId ? await tx.select({ name: schema.services.name }).from(schema.services).where(eq(schema.services.id, ticket.serviceId)).limit(1) : [];
  const [assignee] = ticket.assigneeId ? await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ticket.assigneeId)).limit(1) : [];
  const [reopen] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'tickets.reopen_window_days')).limit(1);
  return {
    ticket: {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      type: ticket.type,
      typeLabel: TYPE_LABEL[ticket.type],
      status: label(ticket.statusId),
      priority: label(ticket.priorityId),
      customerName: customer?.name ?? '',
      service: service?.name ?? '',
      assignee: assignee?.name ?? '',
      link: ticketLink(ticket.id, portal),
      description: ticket.description ?? '',
      resolutionNotes: ticket.resolutionNotes ?? '',
      isMajor: ticket.isMajor,
      escalationLevel: ticket.escalationLevel,
    },
    actor: actorName,
    comment: extra.comment ?? '',
    previousStatus: extra.previousStatus ?? '',
    level: extra.level ?? ticket.escalationLevel,
    reason: extra.reason ?? '',
    sla: extra.sla ? { metric: extra.sla.metric, dueAt: extra.sla.dueAt?.toISOString() ?? '', pct: Math.round(extra.sla.pct) } : { metric: '', dueAt: '', pct: 0 },
    reopenDays: Number(reopen?.value ?? 14),
  };
}

/**
 * Sends a ticket event through the notification rules configured for it.
 * Recipients come from `notification_rules.recipients` flags; the actor is
 * never notified about their own action. Runs in the caller's transaction.
 */
export async function notifyTicketEvent(ctx: Ctx, event: NotificationEvent, ticket: TicketRow, extra: NotifyExtra = {}): Promise<number> {
  const tx = ctx.tx;
  try {
    const rules = await tx.select().from(schema.notificationRules).where(and(eq(schema.notificationRules.event, event), eq(schema.notificationRules.isActive, true)));
    let flags: RecipientFlags = {};
    let channels = new Set<NotificationChannel>();
    if (extra.recipientOverride) {
      flags = extra.recipientOverride;
      (extra.channels ?? ['email', 'in_app']).forEach((c) => channels.add(c));
    } else {
      for (const r of rules) {
        const f = (r.recipients ?? {}) as RecipientFlags;
        for (const k of ['requester', 'assignee', 'team', 'watchers', 'manager', 'customerContacts', 'approvers', 'accountManager', 'onCall'] as const) if (f[k]) flags[k] = true;
        flags.roles = [...(flags.roles ?? []), ...(f.roles ?? [])];
        flags.users = [...(flags.users ?? []), ...(f.users ?? [])];
        flags.emails = [...(flags.emails ?? []), ...(f.emails ?? [])];
        (r.channels as NotificationChannel[]).forEach((c) => channels.add(c));
      }
      if (!rules.length && extra.recipientFallback) {
        flags = extra.recipientFallback;
        (extra.channels ?? ['email', 'in_app']).forEach((c) => channels.add(c));
      }
      if (extra.channels) channels = new Set(extra.channels);
    }
    if (!rules.length && !extra.recipientOverride && !extra.recipientFallback && !extra.extraRecipients?.length) return 0;
    if (!channels.size) channels = new Set(['email', 'in_app']);

    const { msp, portal } = await resolveRecipients(tx, ticket, flags);
    for (const r of extra.extraRecipients ?? []) msp.push(r);
    const exclude = new Set<string>(extra.excludeUserIds ?? []);
    if (!isSystemCtx(ctx) && !ctx.user.apiKeyId) exclude.add(ctx.user.id);
    const actorEmail = isSystemCtx(ctx) ? null : ctx.user.email.toLowerCase();
    const keep = (r: Recipient) => !(r.userId && exclude.has(r.userId)) && !(r.email && actorEmail && r.email.toLowerCase() === actorEmail);
    const mspList = msp.filter(keep);
    const portalList = portal.filter(keep);
    let queued = 0;
    const channelList = [...channels];
    if (mspList.length) {
      const data = await templateData(tx, ticket, ctx.user.name, extra, false);
      queued += await queueNotification(tx, { event, recipients: mspList, data, customerId: ticket.customerId, channels: channelList, entityType: 'ticket', entityId: ticket.id, link: `/tickets/${ticket.id}`, body: extra.comment ?? undefined });
    }
    if (portalList.length) {
      const data = await templateData(tx, ticket, ctx.user.name, extra, true);
      queued += await queueNotification(tx, { event, recipients: portalList, data, customerId: ticket.customerId, channels: channelList, entityType: 'ticket', entityId: ticket.id, link: `/portal/tickets/${ticket.id}`, body: extra.comment ?? undefined });
    }
    return queued;
  } catch (err) {
    // Notifications must never fail the business operation.
    logger.error({ err, event, ticketId: ticket.id }, 'ticket notification failed');
    return 0;
  }
}

/** Helper for escalation rule actions: resolves team manager / roles / users into recipients. */
export async function escalationRecipients(tx: Tx, ticket: TicketRow, opts: { assignee?: boolean; team?: boolean; manager?: boolean; onCall?: boolean; roles?: string[]; userIds?: string[]; emails?: string[] }): Promise<Recipient[]> {
  const { msp, portal } = await resolveRecipients(tx, ticket, { assignee: opts.assignee, team: opts.team, manager: opts.manager, onCall: opts.onCall, roles: opts.roles, users: opts.userIds, emails: opts.emails });
  return [...msp, ...portal];
}

