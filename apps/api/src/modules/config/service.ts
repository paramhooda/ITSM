import { eq, and, asc, sql, inArray } from 'drizzle-orm';
import { OPTION_TYPES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { encryptSecret, isEncrypted } from '@/lib/crypto';

/** Everything the UI needs to render forms, filters and badges, in one call. */
export async function lookups(ctx: Ctx) {
  const [options, teams, ciTypes, relationshipTypes, slaPolicies, calendars, services, settings] = await Promise.all([
    ctx.tx.select().from(schema.configOptions).orderBy(asc(schema.configOptions.type), asc(schema.configOptions.sortOrder), asc(schema.configOptions.label)),
    ctx.tx.select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, teamType: schema.teams.teamType, isActive: schema.teams.isActive }).from(schema.teams).where(eq(schema.teams.isActive, true)).orderBy(asc(schema.teams.name)),
    ctx.tx.select({ id: schema.ciTypes.id, key: schema.ciTypes.key, name: schema.ciTypes.name, icon: schema.ciTypes.icon, color: schema.ciTypes.color, attributeSchema: schema.ciTypes.attributeSchema, parentKey: schema.ciTypes.parentKey }).from(schema.ciTypes).where(eq(schema.ciTypes.isActive, true)).orderBy(asc(schema.ciTypes.sortOrder)),
    ctx.tx.select({ id: schema.ciRelationshipTypes.id, key: schema.ciRelationshipTypes.key, name: schema.ciRelationshipTypes.name, inverseName: schema.ciRelationshipTypes.inverseName }).from(schema.ciRelationshipTypes).where(eq(schema.ciRelationshipTypes.isActive, true)).orderBy(asc(schema.ciRelationshipTypes.name)),
    ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name, isDefault: schema.slaPolicies.isDefault }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isActive, true)).orderBy(asc(schema.slaPolicies.name)),
    ctx.tx.select({ id: schema.businessCalendars.id, name: schema.businessCalendars.name, timezone: schema.businessCalendars.timezone, is24x7: schema.businessCalendars.is24x7 }).from(schema.businessCalendars).orderBy(asc(schema.businessCalendars.name)),
    ctx.tx.select({ id: schema.services.id, key: schema.services.key, name: schema.services.name, domain: schema.services.domain, categoryId: schema.services.categoryId, isActive: schema.services.isActive }).from(schema.services).where(eq(schema.services.isActive, true)).orderBy(asc(schema.services.name)),
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

export async function createOption(ctx: Ctx, input: OptionInput) {
  if (!(OPTION_TYPES as readonly string[]).includes(input.type)) throw new ValidationError(`Unknown option type: ${input.type}`);
  if (input.type === 'ticket_status' && !input.statusCategory) throw new ValidationError('Ticket statuses require a status category');
  const [row] = await ctx.tx.insert(schema.configOptions).values({ ...input, isSystem: false }).returning();
  await ctx.audit({ entityType: 'config_option', entityId: row.id, entityLabel: `${row.type}:${row.key}`, action: 'create', metadata: { type: row.type } });
  return row;
}

export async function updateOption(ctx: Ctx, id: string, patch: Partial<OptionInput>) {
  const [before] = await ctx.tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  if (!before) throw new NotFoundError('Option');
  const { type: _t, key: _k, ...rest } = patch;
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

export async function listConfig(ctx: Ctx, kind: string) {
  const def = tableOf(kind);
  const t = def.table as typeof schema.businessCalendars;
  const col = (t as unknown as Record<string, unknown>)[def.orderBy ?? 'name'] as typeof t.name;
  return ctx.tx.select().from(t).orderBy(asc(col));
}

export async function createConfig(ctx: Ctx, kind: string, input: Record<string, unknown>) {
  const def = tableOf(kind);
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
    const stored = key.endsWith('.password') || key.endsWith('.secret') || key.endsWith('.api_key') ? encryptSecret(String(value)) : value;
    await ctx.tx
      .insert(schema.systemSettings)
      .values({ key, value: stored as never, updatedBy: ctx.user.id })
      .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: stored as never, updatedBy: ctx.user.id, updatedAt: new Date() } });
  }
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
