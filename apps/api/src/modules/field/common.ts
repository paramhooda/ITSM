import { eq, and, inArray, or, isNull, sql } from 'drizzle-orm';
import type { NotificationEvent } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError } from '@/core/errors';
import { config } from '@/config';
import { queueNotification, type Recipient } from '@/modules/notifications/dispatch';
import { logger } from '@/core/logger';

export type VisitRow = typeof schema.fieldVisits.$inferSelect;
export type PartRow = typeof schema.fieldVisitParts.$inferSelect;
export type NoteRow = typeof schema.fieldVisitNotes.$inferSelect;
export type ProgramRow = typeof schema.pmPrograms.$inferSelect;
export type OccurrenceRow = typeof schema.pmOccurrences.$inferSelect;

export const isCustomerUser = (ctx: Ctx) => ctx.user.userType === 'customer';
export const isSystemCtx = (ctx: Ctx) => !!ctx.user.isSystem;
/** User id usable in FK columns (null for system / API keys). */
export const userIdOf = (ctx: Ctx): string | null => (isSystemCtx(ctx) || ctx.user.apiKeyId ? null : ctx.user.id);

const appUrl = () => config.APP_URL.replace(/\/$/, '');
export const visitLink = (id: string, portal = false) => `${appUrl()}${portal ? '/portal/maintenance?visit=' : '/field/'}${id}`;
export const pmLink = (occurrenceId: string, portal = false) => `${appUrl()}${portal ? '/portal/maintenance?occurrence=' : '/maintenance?occurrence='}${occurrenceId}`;

export const csv = (v: string | undefined | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
export const todayStr = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** Parses `from`/`to` query values (date or datetime); a plain `to` date is inclusive (end of day). */
export function parseRange(from?: string, to?: string) {
  const f = from ? new Date(from) : null;
  let t = to ? new Date(to) : null;
  if (t && to && to.length <= 10) t = new Date(t.getTime() + 86_400_000);
  return { from: f && !isNaN(f.getTime()) ? f : null, to: t && !isNaN(t.getTime()) ? t : null };
}

// ---------------------------------------------------------------- permissions

/** Read access: MSP users need field:read / pm:read for the customer; customer users portal:access for their own customer. */
export function requireRead(ctx: Ctx, customerId: string, perm: 'field:read' | 'pm:read' = 'field:read') {
  ctx.requireCustomer(customerId);
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access', customerId) || ctx.user.customerId !== customerId) throw new ForbiddenError('Missing permission: portal:access');
    return;
  }
  if (!ctx.can(perm, customerId) && !ctx.can('field:manage', customerId) && !ctx.can('pm:manage', customerId)) throw new ForbiddenError(`Missing permission: ${perm}`);
}

export const isAssignedEngineer = (ctx: Ctx, v: Pick<VisitRow, 'engineerId' | 'additionalEngineerIds'>) => !isCustomerUser(ctx) && (v.engineerId === ctx.user.id || (v.additionalEngineerIds ?? []).includes(ctx.user.id));

/** May manage (create / schedule / cancel / edit) visits of this customer. */
export const canManage = (ctx: Ctx, customerId: string) => !isCustomerUser(ctx) && ctx.can('field:manage', customerId);

/** May execute (start / complete / parts / notes): the assigned engineer with field:execute, or field:manage. */
export function canExecute(ctx: Ctx, v: Pick<VisitRow, 'customerId' | 'engineerId' | 'additionalEngineerIds'>) {
  if (isCustomerUser(ctx)) return false;
  if (ctx.can('field:manage', v.customerId)) return true;
  return ctx.can('field:execute', v.customerId) && isAssignedEngineer(ctx, v);
}

export function requireManage(ctx: Ctx, customerId: string) {
  requireRead(ctx, customerId);
  if (!canManage(ctx, customerId)) throw new ForbiddenError('Missing permission: field:manage');
}

export function requireExecute(ctx: Ctx, v: Pick<VisitRow, 'customerId' | 'engineerId' | 'additionalEngineerIds'>) {
  requireRead(ctx, v.customerId);
  if (!canExecute(ctx, v)) throw new ForbiddenError('Only the assigned engineer (field:execute) or a field manager (field:manage) can do this');
}

// ---------------------------------------------------------------- loading

export async function loadVisit(ctx: Ctx, id: string): Promise<VisitRow> {
  const [row] = await ctx.tx.select().from(schema.fieldVisits).where(eq(schema.fieldVisits.id, id)).limit(1);
  if (!row) throw new NotFoundError('Field visit');
  requireRead(ctx, row.customerId);
  return row;
}

export async function reloadVisit(tx: Tx, id: string): Promise<VisitRow> {
  const [row] = await tx.select().from(schema.fieldVisits).where(eq(schema.fieldVisits.id, id)).limit(1);
  if (!row) throw new NotFoundError('Field visit');
  return row;
}

export async function loadProgram(ctx: Ctx, id: string): Promise<ProgramRow> {
  const [row] = await ctx.tx.select().from(schema.pmPrograms).where(eq(schema.pmPrograms.id, id)).limit(1);
  if (!row) throw new NotFoundError('PM program');
  requireRead(ctx, row.customerId, 'pm:read');
  return row;
}

export async function loadOccurrence(ctx: Ctx, id: string): Promise<{ occurrence: OccurrenceRow; program: ProgramRow }> {
  const [occurrence] = await ctx.tx.select().from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, id)).limit(1);
  if (!occurrence) throw new NotFoundError('PM occurrence');
  requireRead(ctx, occurrence.customerId, 'pm:read');
  const [program] = await ctx.tx.select().from(schema.pmPrograms).where(eq(schema.pmPrograms.id, occurrence.programId)).limit(1);
  if (!program) throw new NotFoundError('PM program');
  return { occurrence, program };
}

// ---------------------------------------------------------------- lookups

export async function optionLabels(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; key: string; label: string; color: string | null }>();
  const rows = await tx.select({ id: schema.configOptions.id, key: schema.configOptions.key, label: schema.configOptions.label, color: schema.configOptions.color }).from(schema.configOptions).where(inArray(schema.configOptions.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function optionByKey(tx: Tx, type: string, key: string) {
  const [row] = await tx.select().from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  return row ?? null;
}

export async function userNames(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; name: string; email: string }>();
  const rows = await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Resolves the entitlement type option keys for a set of entitlements (`site_visits`, `pm_visits`, ...). */
export async function entitlementTypeKeys(tx: Tx, ents: { typeId: string | null }[]) {
  const labels = await optionLabels(tx, ents.map((e) => e.typeId));
  return (e: { typeId: string | null }) => (e.typeId ? labels.get(e.typeId)?.key ?? null : null);
}

/**
 * Picks an entitlement for a visit / PM program on a contract: the first active
 * entitlement of unit `visits` whose type key matches `preferredKey`
 * (`pm_visits` for preventive maintenance, `site_visits` otherwise), with a
 * fallback to any other visit-type entitlement on the contract. Service-specific
 * entitlements win when they match the service.
 */
export async function autoPickVisitEntitlement(tx: Tx, contractId: string | null | undefined, preferredKey: 'site_visits' | 'pm_visits', serviceId?: string | null): Promise<string | null> {
  if (!contractId) return null;
  const ents = await tx
    .select()
    .from(schema.contractEntitlements)
    .where(and(eq(schema.contractEntitlements.contractId, contractId), eq(schema.contractEntitlements.isActive, true), eq(schema.contractEntitlements.unit, 'visits')))
    .orderBy(schema.contractEntitlements.createdAt);
  if (!ents.length) return null;
  const keyOf = await entitlementTypeKeys(tx, ents);
  const score = (e: (typeof ents)[number]) => {
    const key = keyOf(e);
    let s = 0;
    if (key === preferredKey) s += 10;
    else if (key === 'site_visits' || key === 'pm_visits') s += 4;
    if (serviceId && e.serviceId === serviceId) s += 2;
    else if (!e.serviceId) s += 1;
    return s;
  };
  return [...ents].sort((a, b) => score(b) - score(a))[0]?.id ?? null;
}

// ---------------------------------------------------------------- notifications (rule driven, same approach as tickets/notify.ts)

export interface RecipientFlags {
  requester?: boolean;
  assignee?: boolean;
  team?: boolean;
  manager?: boolean;
  customerContacts?: boolean;
  accountManager?: boolean;
  roles?: string[];
  users?: string[];
  emails?: string[];
}

export interface NotifyTarget {
  customerId: string;
  /** Engineer(s): visit engineer + additional engineers, or PM engineer. */
  assigneeIds?: (string | null | undefined)[];
  teamId?: string | null;
  requesterUserId?: string | null;
}

interface UserLite {
  id: string;
  email: string;
  name: string;
  userType: 'msp' | 'customer';
}

async function usersByIds(tx: Tx, ids: string[]): Promise<UserLite[]> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return [];
  return tx.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, userType: schema.users.userType }).from(schema.users).where(and(inArray(schema.users.id, clean), eq(schema.users.status, 'active')));
}

async function usersWithRoles(tx: Tx, roleKeys: string[], customerId: string): Promise<UserLite[]> {
  if (!roleKeys.length) return [];
  const rows = await tx
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, userType: schema.users.userType })
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
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, userType: schema.users.userType })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
    .where(and(inArray(schema.teamMembers.teamId, clean), eq(schema.users.status, 'active')));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Resolves recipient flags against a visit / occurrence into concrete recipients (split by portal vs MSP link). */
export async function resolveRecipients(tx: Tx, target: NotifyTarget, flags: RecipientFlags): Promise<{ msp: Recipient[]; portal: Recipient[] }> {
  const userIds = new Set<string>();
  const portal: Recipient[] = [];
  const msp: Recipient[] = [];
  const users: UserLite[] = [];
  if (flags.assignee) (target.assigneeIds ?? []).forEach((id) => id && userIds.add(id));
  if (flags.requester && target.requesterUserId) userIds.add(target.requesterUserId);
  if (flags.team && target.teamId) users.push(...(await usersInTeams(tx, [target.teamId])));
  if (flags.manager && target.teamId) {
    const [t] = await tx.select({ managerUserId: schema.teams.managerUserId }).from(schema.teams).where(eq(schema.teams.id, target.teamId)).limit(1);
    if (t?.managerUserId) userIds.add(t.managerUserId);
  }
  if (flags.accountManager) {
    const [c] = await tx.select({ accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, target.customerId)).limit(1);
    if (c?.accountManagerId) userIds.add(c.accountManagerId);
  }
  if (flags.customerContacts) {
    const rows = await tx
      .select({ email: schema.contacts.email, name: schema.contacts.name, userId: schema.contacts.userId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.customerId, target.customerId), eq(schema.contacts.isActive, true), or(eq(schema.contacts.isEscalation, true), eq(schema.contacts.isPrimary, true))));
    for (const c of rows) {
      if (c.userId) userIds.add(c.userId);
      else if (c.email) portal.push({ email: c.email, name: c.name });
    }
  }
  if (flags.roles?.length) users.push(...(await usersWithRoles(tx, flags.roles, target.customerId)));
  if (flags.users?.length) flags.users.forEach((u) => userIds.add(u));
  if (flags.emails?.length) flags.emails.forEach((e) => msp.push({ email: e }));
  users.push(...(await usersByIds(tx, [...userIds])));
  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    const rcpt: Recipient = { userId: u.id, email: u.email, name: u.name };
    if (u.userType === 'customer') portal.push(rcpt);
    else msp.push(rcpt);
  }
  return { msp, portal };
}

export interface NotifyOptions {
  /** Template data; `link` is added per audience (MSP vs portal). */
  data: Record<string, unknown>;
  entityType: 'field_visit' | 'pm_occurrence';
  entityId: string;
  mspLink: string;
  portalLink: string;
  title?: string;
  body?: string;
  /** Extra recipients regardless of rules. */
  extraRecipients?: Recipient[];
}

/**
 * Sends a field / PM event through the notification rules configured for it.
 * Recipient flags come from `notification_rules.recipients`; the actor is never
 * notified about their own action. Never fails the business operation.
 */
export async function notifyFieldEvent(ctx: Ctx, event: NotificationEvent, target: NotifyTarget, opts: NotifyOptions): Promise<number> {
  const tx = ctx.tx;
  try {
    const rules = await tx.select().from(schema.notificationRules).where(and(eq(schema.notificationRules.event, event), eq(schema.notificationRules.isActive, true)));
    if (!rules.length && !opts.extraRecipients?.length) return 0;
    const flags: RecipientFlags = {};
    let channels = new Set<'email' | 'in_app'>();
    for (const r of rules) {
      const f = (r.recipients ?? {}) as RecipientFlags;
      for (const k of ['requester', 'assignee', 'team', 'manager', 'customerContacts', 'accountManager'] as const) if (f[k]) flags[k] = true;
      flags.roles = [...(flags.roles ?? []), ...(f.roles ?? [])];
      flags.users = [...(flags.users ?? []), ...(f.users ?? [])];
      flags.emails = [...(flags.emails ?? []), ...(f.emails ?? [])];
      (r.channels as ('email' | 'in_app')[]).forEach((c) => channels.add(c));
    }
    if (!channels.size) channels = new Set(['email', 'in_app']);
    const { msp, portal } = await resolveRecipients(tx, target, flags);
    for (const r of opts.extraRecipients ?? []) msp.push(r);
    const actorId = isSystemCtx(ctx) || ctx.user.apiKeyId ? null : ctx.user.id;
    const actorEmail = isSystemCtx(ctx) ? null : ctx.user.email.toLowerCase();
    const keep = (r: Recipient) => !(r.userId && actorId && r.userId === actorId) && !(r.email && actorEmail && r.email.toLowerCase() === actorEmail);
    const mspList = msp.filter(keep);
    const portalList = portal.filter(keep);
    const channelList = [...channels];
    let queued = 0;
    const base = { event, customerId: target.customerId, channels: channelList, entityType: opts.entityType, entityId: opts.entityId, title: opts.title, body: opts.body };
    if (mspList.length) queued += await queueNotification(tx, { ...base, recipients: mspList, data: { ...opts.data, link: opts.mspLink, actor: ctx.user.name }, link: opts.mspLink });
    if (portalList.length) queued += await queueNotification(tx, { ...base, recipients: portalList, data: { ...opts.data, link: opts.portalLink, actor: ctx.user.name }, link: opts.portalLink });
    return queued;
  } catch (err) {
    logger.error({ err, event, entityId: opts.entityId }, 'field notification failed');
    return 0;
  }
}

export const countSql = sql<number>`count(*)::int`;

/** Runs async thunks one after another on the same transaction client (pg does not allow concurrent queries on one client). */
export async function sequential<T extends unknown[]>(thunks: [...{ [K in keyof T]: () => Promise<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const t of thunks) out.push(await t());
  return out as T;
}

/**
 * Converts a civil date + wall-clock time in an IANA time zone into an instant.
 * Falls back to UTC for unknown zones.
 */
export function zonedDateTime(dateStr: string, time: string, timeZone: string | null | undefined): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm ?? 0, 0);
  let tz = timeZone || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const wall = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  // The offset at the guessed instant moves the wall clock; correct once (twice for DST edges).
  let utc = guess - (wall(guess) - guess);
  utc = utc - (wall(utc) - guess);
  return new Date(utc);
}

/** Civil date (YYYY-MM-DD) of an instant in a time zone. */
export function dateInZone(at: Date, timeZone: string | null | undefined): string {
  let tz = timeZone || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
