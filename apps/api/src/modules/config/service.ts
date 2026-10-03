import { resetWhatsAppSettingsCache, assertWebhookUrl } from '@/modules/notifications/channels';
import { eq, and, or, asc, sql, inArray, lt, lte, gte, isNull, isNotNull } from 'drizzle-orm';
import { OPTION_TYPES, OPTION_PARENT_TYPES, IMPACT_DIRECTIONS, type OptionType } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ValidationError, ForbiddenError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { encryptSecret, isEncrypted } from '@/lib/crypto';

/** Everything the UI needs to render forms, filters and badges, in one call. */
export async function lookups(ctx: Ctx) {
  const [options, teams, ciTypes, relationshipTypes, slaPolicies, calendars, services, settings] = await Promise.all([
    ctx.tx.select().from(schema.configOptions).orderBy(asc(schema.configOptions.type), asc(schema.configOptions.sortOrder), asc(schema.configOptions.label)),
    ctx.tx.select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, teamType: schema.teams.teamType, isActive: schema.teams.isActive }).from(schema.teams).where(eq(schema.teams.isActive, true)).orderBy(asc(schema.teams.name)),
    ctx.tx.select({ id: schema.ciTypes.id, key: schema.ciTypes.key, name: schema.ciTypes.name, icon: schema.ciTypes.icon, color: schema.ciTypes.color, attributeSchema: schema.ciTypes.attributeSchema, parentKey: schema.ciTypes.parentKey }).from(schema.ciTypes).where(eq(schema.ciTypes.isActive, true)).orderBy(asc(schema.ciTypes.sortOrder)),
    ctx.tx.select({ id: schema.ciRelationshipTypes.id, key: schema.ciRelationshipTypes.key, name: schema.ciRelationshipTypes.name, inverseName: schema.ciRelationshipTypes.inverseName, impactDirection: schema.ciRelationshipTypes.impactDirection }).from(schema.ciRelationshipTypes).where(eq(schema.ciRelationshipTypes.isActive, true)).orderBy(asc(schema.ciRelationshipTypes.name)),
    ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name, isDefault: schema.slaPolicies.isDefault }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isActive, true)).orderBy(asc(schema.slaPolicies.name)),
    ctx.tx.select({ id: schema.businessCalendars.id, name: schema.businessCalendars.name, timezone: schema.businessCalendars.timezone, is24x7: schema.businessCalendars.is24x7 }).from(schema.businessCalendars).orderBy(asc(schema.businessCalendars.name)),
    ctx.tx.select({ id: schema.services.id, key: schema.services.key, name: schema.services.name, domain: schema.services.domain, categoryId: schema.services.categoryId, subcategoryId: schema.services.subcategoryId, isActive: schema.services.isActive }).from(schema.services).where(eq(schema.services.isActive, true)).orderBy(asc(schema.services.name)),
    ctx.tx.select().from(schema.systemSettings),
  ]);
  const grouped: Record<string, typeof options> = {};
  for (const o of options) (grouped[o.type] ??= []).push(o);
  const publicSettings: Record<string, unknown> = {};
  for (const s of settings) if (!s.key.startsWith('security.') && !s.key.startsWith('smtp.')) publicSettings[s.key] = s.value;
  return { options: grouped, teams, ciTypes, relationshipTypes, slaPolicies, calendars, services, settings: publicSettings };
}

// ---------------------------------------------------------------- option lists

export async function listOptions(ctx: Ctx, type?: string, includeInactive = true) {
  const conds = [];
  if (type) conds.push(eq(schema.configOptions.type, type));
  if (!includeInactive) conds.push(eq(schema.configOptions.isActive, true));
  return ctx.tx.select().from(schema.configOptions).where(conds.length ? and(...conds) : undefined).orderBy(asc(schema.configOptions.type), asc(schema.configOptions.sortOrder), asc(schema.configOptions.label));
}

export type OptionInput = Partial<typeof schema.configOptions.$inferInsert> & { type: string; key: string; label: string };

/**
 * Sub-option types (ticket_subcategory, service_subcategory) must point at an
 * option of their parent type. Returns without checking for other types.
 */
export async function assertOptionParent(ctx: Ctx, type: string, parentId: string | null | undefined) {
  const parentType = OPTION_PARENT_TYPES[type as OptionType];
  if (!parentType) return;
  const label = type.replace(/_/g, ' ');
  if (!parentId) throw new ValidationError(`A ${label} requires a parent ${parentType.replace(/_/g, ' ')}`);
  const [parent] = await ctx.tx.select({ id: schema.configOptions.id, type: schema.configOptions.type }).from(schema.configOptions).where(eq(schema.configOptions.id, parentId)).limit(1);
  if (!parent || parent.type !== parentType) throw new ValidationError(`The parent of a ${label} must be a ${parentType.replace(/_/g, ' ')} option`);
}

export async function createOption(ctx: Ctx, input: OptionInput) {
  if (!(OPTION_TYPES as readonly string[]).includes(input.type)) throw new ValidationError(`Unknown option type: ${input.type}`);
  if (input.type === 'ticket_status' && !input.statusCategory) throw new ValidationError('Ticket statuses require a status category');
  await assertOptionParent(ctx, input.type, input.parentId);
  const [row] = await ctx.tx.insert(schema.configOptions).values({ ...input, isSystem: false }).returning();
  await ctx.audit({ entityType: 'config_option', entityId: row.id, entityLabel: `${row.type}:${row.key}`, action: 'create', metadata: { type: row.type } });
  return row;
}

export async function updateOption(ctx: Ctx, id: string, patch: Partial<OptionInput>) {
  const [before] = await ctx.tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  if (!before) throw new NotFoundError('Option');
  const { type: _t, key: _k, ...rest } = patch;
  if (rest.parentId !== undefined) await assertOptionParent(ctx, before.type, rest.parentId);
  if (patch.isDefault) await ctx.tx.update(schema.configOptions).set({ isDefault: false }).where(and(eq(schema.configOptions.type, before.type), sql`${schema.configOptions.appliesTo} = ${before.appliesTo}`));
  const [after] = await ctx.tx.update(schema.configOptions).set({ ...rest, updatedAt: new Date() }).where(eq(schema.configOptions.id, id)).returning();
  await ctx.audit({ entityType: 'config_option', entityId: id, entityLabel: `${after.type}:${after.key}`, action: 'update', changes: diffChanges(before as Record<string, unknown>, rest as Record<string, unknown>) });
  return after;
}

export async function deleteOption(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  if (!row) throw new NotFoundError('Option');
  if (row.isSystem) {
    // System options are deactivated rather than removed so historical records keep their labels.
    await ctx.tx.update(schema.configOptions).set({ isActive: false, updatedAt: new Date() }).where(eq(schema.configOptions.id, id));
    await ctx.audit({ entityType: 'config_option', entityId: id, entityLabel: `${row.type}:${row.key}`, action: 'deactivate' });
    return { deactivated: true };
  }
  await ctx.tx.delete(schema.configOptions).where(eq(schema.configOptions.id, id));
  await ctx.audit({ entityType: 'config_option', entityId: id, entityLabel: `${row.type}:${row.key}`, action: 'delete' });
  return { deleted: true };
}

export async function reorderOptions(ctx: Ctx, ids: string[]) {
  for (let i = 0; i < ids.length; i++) await ctx.tx.update(schema.configOptions).set({ sortOrder: (i + 1) * 10 }).where(eq(schema.configOptions.id, ids[i]));
  await ctx.audit({ entityType: 'config_option', action: 'reorder', metadata: { ids } });
}

// ---------------------------------------------------------------- priority matrix

export async function getPriorityMatrix(ctx: Ctx) {
  return ctx.tx.select().from(schema.priorityMatrix);
}

export async function setPriorityMatrix(ctx: Ctx, cells: { impactId: string; urgencyId: string; priorityId: string }[]) {
  await ctx.tx.delete(schema.priorityMatrix);
  if (cells.length) await ctx.tx.insert(schema.priorityMatrix).values(cells);
  await ctx.audit({ entityType: 'priority_matrix', action: 'update', metadata: { cells: cells.length } });
  return cells;
}

// ---------------------------------------------------------------- generic admin CRUD for config tables

type Table = typeof schema.businessCalendars | typeof schema.holidayCalendars | typeof schema.notificationTemplates | typeof schema.notificationRules | typeof schema.assignmentRules | typeof schema.escalationRules | typeof schema.approvalWorkflows | typeof schema.customFieldDefinitions | typeof schema.ciTypes | typeof schema.ciRelationshipTypes;

export const CONFIG_TABLES: Record<string, { table: Table; label: string; orderBy?: string }> = {
  calendars: { table: schema.businessCalendars, label: 'business_calendar', orderBy: 'name' },
  'holiday-calendars': { table: schema.holidayCalendars, label: 'holiday_calendar', orderBy: 'name' },
  'notification-templates': { table: schema.notificationTemplates, label: 'notification_template', orderBy: 'event' },
  'notification-rules': { table: schema.notificationRules, label: 'notification_rule', orderBy: 'event' },
  'assignment-rules': { table: schema.assignmentRules, label: 'assignment_rule', orderBy: 'sortOrder' },
  'escalation-rules': { table: schema.escalationRules, label: 'escalation_rule', orderBy: 'sortOrder' },
  'approval-workflows': { table: schema.approvalWorkflows, label: 'approval_workflow', orderBy: 'name' },
  'custom-fields': { table: schema.customFieldDefinitions, label: 'custom_field', orderBy: 'entity' },
  'ci-types': { table: schema.ciTypes, label: 'ci_type', orderBy: 'sortOrder' },
  'relationship-types': { table: schema.ciRelationshipTypes, label: 'ci_relationship_type', orderBy: 'name' },
};

function tableOf(kind: string) {
  const def = CONFIG_TABLES[kind];
  if (!def) throw new NotFoundError('Configuration area');
  return def;
}

/** Field-level validation for config kinds whose columns carry enumerated values. */
function validateConfigInput(kind: string, input: Record<string, unknown>) {
  if (kind === 'relationship-types' && input.impactDirection !== undefined && !(IMPACT_DIRECTIONS as readonly unknown[]).includes(input.impactDirection)) {
    throw new ValidationError(`impactDirection must be one of: ${IMPACT_DIRECTIONS.join(', ')}`);
  }
}

export async function listConfig(ctx: Ctx, kind: string) {
  const def = tableOf(kind);
  const t = def.table as typeof schema.businessCalendars;
  const col = (t as unknown as Record<string, unknown>)[def.orderBy ?? 'name'] as typeof t.name;
  return ctx.tx.select().from(t).orderBy(asc(col));
}

export async function createConfig(ctx: Ctx, kind: string, input: Record<string, unknown>) {
  const def = tableOf(kind);
  validateConfigInput(kind, input);
  const [row] = await ctx.tx.insert(def.table as typeof schema.businessCalendars).values(input as never).returning();
  await ctx.audit({ entityType: def.label, entityId: (row as { id: string }).id, entityLabel: String((row as { name?: string }).name ?? ''), action: 'create' });
  return row;
}

export async function updateConfig(ctx: Ctx, kind: string, id: string, patch: Record<string, unknown>) {
  const def = tableOf(kind);
  const t = def.table as typeof schema.businessCalendars;
  const [before] = await ctx.tx.select().from(t).where(eq(t.id, id)).limit(1);
  if (!before) throw new NotFoundError(def.label);
  const { id: _id, createdAt: _c, isSystem: _s, ...rest } = patch;
  validateConfigInput(kind, rest);
  if (kind === 'calendars' && patch.isDefault) await ctx.tx.update(schema.businessCalendars).set({ isDefault: false });
  const [after] = await ctx.tx.update(t).set({ ...(rest as object), updatedAt: new Date() } as never).where(eq(t.id, id)).returning();
  await ctx.audit({ entityType: def.label, entityId: id, entityLabel: String((after as { name?: string }).name ?? ''), action: 'update', changes: diffChanges(before as Record<string, unknown>, rest) });
  return after;
}

export async function deleteConfig(ctx: Ctx, kind: string, id: string) {
  const def = tableOf(kind);
  const t = def.table as typeof schema.businessCalendars;
  const [row] = await ctx.tx.select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) throw new NotFoundError(def.label);
  if ((row as { isSystem?: boolean }).isSystem) throw new ValidationError('System entries cannot be deleted; deactivate them instead');
  await ctx.tx.delete(t).where(eq(t.id, id));
  await ctx.audit({ entityType: def.label, entityId: id, entityLabel: String((row as { name?: string }).name ?? ''), action: 'delete' });
}

// ---------------------------------------------------------------- holidays

export async function listHolidays(ctx: Ctx, calendarId: string) {
  return ctx.tx.select().from(schema.holidays).where(eq(schema.holidays.calendarId, calendarId)).orderBy(asc(schema.holidays.date));
}

export async function setHolidays(ctx: Ctx, calendarId: string, items: { date: string; name: string }[]) {
  await ctx.tx.delete(schema.holidays).where(eq(schema.holidays.calendarId, calendarId));
  if (items.length) await ctx.tx.insert(schema.holidays).values(items.map((h) => ({ calendarId, date: h.date, name: h.name })));
  await ctx.audit({ entityType: 'holiday_calendar', entityId: calendarId, action: 'holidays.update', metadata: { count: items.length } });
  return listHolidays(ctx, calendarId);
}

// ---------------------------------------------------------------- settings

export async function listSettings(ctx: Ctx) {
  const rows = await ctx.tx.select().from(schema.systemSettings).orderBy(asc(schema.systemSettings.key));
  return rows.map((r) => ({ ...r, value: isEncrypted(r.value) ? '********' : r.value }));
}

export async function updateSettings(ctx: Ctx, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === '********') continue;
    if (key === 'whatsapp.webhook_url') assertWebhookUrl(value);
    const stored = key.endsWith('.password') || key.endsWith('.secret') || key.endsWith('.api_key') ? encryptSecret(String(value)) : value;
    await ctx.tx
      .insert(schema.systemSettings)
      .values({ key, value: stored as never, updatedBy: ctx.user.id })
      .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: stored as never, updatedBy: ctx.user.id, updatedAt: new Date() } });
  }
  if (Object.keys(patch).some((k) => k.startsWith('whatsapp.'))) resetWhatsAppSettingsCache();
  await ctx.audit({ entityType: 'system_settings', action: 'update', metadata: { keys: Object.keys(patch) } });
  return listSettings(ctx);
}

export async function getSetting<T = unknown>(ctx: Ctx, key: string, fallback: T): Promise<T> {
  const [row] = await ctx.tx.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1);
  return (row?.value as T) ?? fallback;
}

export async function optionsByIds(ctx: Ctx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, typeof schema.configOptions.$inferSelect>();
  const rows = await ctx.tx.select().from(schema.configOptions).where(inArray(schema.configOptions.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------- admin attention

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: 'bad' | 'warn' | 'info';
  /** Where to act on it in the web app. */
  to: string;
}

/**
 * What an administrator should look at now: delivery failures, silent
 * integrations, expiring access, findings to review and configuration gaps.
 * Only items with a count above zero are returned.
 */
export async function attention(ctx: Ctx): Promise<{ items: AttentionItem[] }> {
  if (!ctx.can('admin:config') && !ctx.can('admin:system')) throw new ForbiddenError('Missing permission: admin:config or admin:system');
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3_600_000);
  const in14Days = new Date(now + 14 * 86_400_000);
  const n = sql<number>`count(*)::int`;
  const count = async (q: PromiseLike<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const [outboxFailed, integrationsSilent, keysExpiring, findingsPending, policiesUnused, usersInvited, usersLocked, assignmentOff, escalationOff] = await Promise.all([
    count(ctx.tx.select({ n }).from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.status, 'failed'), gte(schema.notificationOutbox.createdAt, dayAgo)))),
    count(ctx.tx.select({ n }).from(schema.integrations).where(and(eq(schema.integrations.isActive, true), or(lt(schema.integrations.lastEventAt, dayAgo), and(isNull(schema.integrations.lastEventAt), lt(schema.integrations.createdAt, dayAgo)))))),
    count(ctx.tx.select({ n }).from(schema.apiKeys).where(and(isNull(schema.apiKeys.revokedAt), isNotNull(schema.apiKeys.expiresAt), lte(schema.apiKeys.expiresAt, in14Days)))),
    count(ctx.tx.select({ n }).from(schema.discoveryFindings).where(eq(schema.discoveryFindings.status, 'pending'))),
    count(
      ctx.tx
        .select({ n })
        .from(schema.slaPolicies)
        .where(
          and(
            eq(schema.slaPolicies.isActive, true),
            eq(schema.slaPolicies.isDefault, false),
            sql`not exists (select 1 from ${schema.contracts} where ${schema.contracts.slaPolicyId} = ${schema.slaPolicies.id})`,
            sql`not exists (select 1 from ${schema.contractServices} where ${schema.contractServices.slaPolicyId} = ${schema.slaPolicies.id})`,
          ),
        ),
    ),
    count(ctx.tx.select({ n }).from(schema.users).where(eq(schema.users.status, 'invited'))),
    count(ctx.tx.select({ n }).from(schema.users).where(eq(schema.users.status, 'locked'))),
    count(ctx.tx.select({ n }).from(schema.assignmentRules).where(eq(schema.assignmentRules.isActive, false))),
    count(ctx.tx.select({ n }).from(schema.escalationRules).where(eq(schema.escalationRules.isActive, false))),
  ]);
  const all: AttentionItem[] = [
    { key: 'outbox_failed', label: 'Notification deliveries failed in the last 24 hours', count: outboxFailed, tone: 'bad', to: '/admin/outbox' },
    { key: 'integrations_silent', label: 'Active integrations with no events in the last 24 hours', count: integrationsSilent, tone: 'warn', to: '/admin/integrations?tab=integrations' },
    { key: 'api_keys_expiring', label: 'API keys expired or expiring within 14 days', count: keysExpiring, tone: 'warn', to: '/admin/api-keys' },
    { key: 'discovery_findings_pending', label: 'Discovery findings waiting for review', count: findingsPending, tone: 'info', to: '/cmdb/discovery/findings?status=pending' },
    { key: 'sla_policies_unused', label: 'SLA policies with no contracts assigned', count: policiesUnused, tone: 'info', to: '/admin/sla' },
    { key: 'users_invited', label: 'Invited users who have not signed in yet', count: usersInvited, tone: 'info', to: '/admin/users?status=invited' },
    { key: 'users_locked', label: 'Locked user accounts', count: usersLocked, tone: 'warn', to: '/admin/users?status=locked' },
    { key: 'assignment_rules_disabled', label: 'Assignment rules disabled', count: assignmentOff, tone: 'info', to: '/admin/assignment-rules' },
    { key: 'escalation_rules_disabled', label: 'Escalation rules disabled', count: escalationOff, tone: 'info', to: '/admin/escalation-rules' },
  ];
  return { items: all.filter((i) => i.count > 0) };
}
