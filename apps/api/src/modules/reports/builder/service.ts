import { eq, and, or, desc, sql, inArray, ilike, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema, type Tx } from '@/db/client';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import type { ReportSpec } from '@/db/schema/report-definitions';
import { isCustomerUser, resolveCustomerId, setCustomLoader, setCustomLister, CUSTOM_PREFIX, isCustomKey, type ReportDefinition, type ReportParams, type ReportResult, type ReportChart, type ReportCategory, type CustomDefinition } from '../registry';
import { resolveDateRange, todayIn, DATE_RANGE_PRESETS, type DateRangePreset, type DateRange } from '../dates';
import { rows as queryRows, customerParam, dateRangeParam } from '../definitions/helpers';
import { ENTITIES, OPERATORS, OPERATOR_LABELS, catalogFor, entityPermitted, entityOf, type EntityDef, type EntityKey, type LookupKind, type PublicEntity } from './catalog';
import { validateSpec, compileSpec, describeSpec, filterLookups, aggregateAlias } from './compile';
import { loadBuilderLimits, type BuilderLimits } from './limits';
import type { DefinitionInput, DefinitionPatch, ListQuery, PreviewBody } from './schemas';

/**
 * Custom report definitions: who may see, edit and delete one, the live preview,
 * the executor the report runner calls through the virtual `custom:<id>`
 * definition, and the catalogue the builder page reads. Every query runs under
 * the caller's tenant transaction and the entity's own fences (SOC, customer
 * scope); the statement runs inside a savepoint with its own time limit so a
 * cancelled query never aborts the enclosing transaction.
 */

export type DefinitionRow = typeof schema.reportDefinitions.$inferSelect;
const defs = schema.reportDefinitions;

export const customKey = (id: string) => `${CUSTOM_PREFIX}${id}`;
export const customIdOf = (key: string) => (isCustomKey(key) ? key.slice(CUSTOM_PREFIX.length) : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const like = (s: string) => `%${s.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const PORTAL_MESSAGE = 'The report builder is not available in the customer portal';

const entityOrThrow = (key: string): EntityDef => {
  const e = entityOf(key);
  if (!e) throw new ValidationError(`Unknown report entity "${key}"`);
  return e;
};

// ---------------------------------------------------------------- visibility

const sharedWith = (ctx: Ctx, row: DefinitionRow) => row.visibility === 'shared' && (row.sharedRoleKeys.some((k) => ctx.user.roles.some((r) => r.key === k)) || row.sharedTeamIds.some((id) => ctx.user.teams.some((t) => t.id === id)));

/**
 * Who may see a stored definition: the system principal (the schedule worker), the
 * owner, a role or team it is shared with, reports:manage holders, or (portal) a
 * published, active row for the caller's organisation. Staff additionally need to
 * see the customer a report is fixed to.
 */
export function canSeeDefinition(ctx: Ctx, row: DefinitionRow): boolean {
  if (ctx.user.isSystem) return true;
  if (isCustomerUser(ctx)) return row.portalVisible && row.isActive && (!row.scopeCustomerId || row.scopeCustomerId === ctx.user.customerId) && ctx.can('portal:reports', ctx.user.customerId);
  if (row.scopeCustomerId && !ctx.canSeeCustomer(row.scopeCustomerId)) return false;
  if (row.ownerId && row.ownerId === ctx.user.id) return true;
  if (ctx.can('reports:manage')) return true;
  return sharedWith(ctx, row);
}

/** The owner, reports:manage holders, or someone the report is shared with who also holds reports:build; never a portal user. */
export function canEditDefinition(ctx: Ctx, row: DefinitionRow): boolean {
  if (isCustomerUser(ctx) || ctx.user.isSystem) return false;
  if (ctx.can('reports:manage')) return true;
  if (row.ownerId && row.ownerId === ctx.user.id) return true;
  return ctx.can('reports:build') && sharedWith(ctx, row);
}

/** Only the owner and reports:manage holders may retire a report. */
export const canDeleteDefinition = (ctx: Ctx, row: DefinitionRow): boolean => !isCustomerUser(ctx) && !ctx.user.isSystem && (ctx.can('reports:manage') || (!!row.ownerId && row.ownerId === ctx.user.id));

const PRIVATE_UUID = '00000000-0000-0000-0000-000000000000';

/** Rows the caller may see: an SQL prefilter (owner, shared, portal, active) then canSeeDefinition. */
export async function visibleDefinitionRows(ctx: Ctx, opts: { includeInactive?: boolean; entity?: string; mine?: boolean; q?: string } = {}): Promise<DefinitionRow[]> {
  const conds: SQL[] = [];
  if (isCustomerUser(ctx)) conds.push(eq(defs.portalVisible, true), eq(defs.isActive, true));
  else {
    if (!opts.includeInactive) conds.push(eq(defs.isActive, true));
    if (!ctx.user.isSystem && !ctx.can('reports:manage')) conds.push(or(eq(defs.ownerId, ctx.user.apiKeyId ? PRIVATE_UUID : ctx.user.id), eq(defs.visibility, 'shared'))!);
  }
  if (opts.entity) conds.push(eq(defs.entity, opts.entity));
  if (opts.mine && !isCustomerUser(ctx)) conds.push(eq(defs.ownerId, ctx.user.apiKeyId ? PRIVATE_UUID : ctx.user.id));
  if (opts.q?.trim()) conds.push(or(ilike(defs.name, like(opts.q)), ilike(defs.description, like(opts.q)))!);
  // no cap: the prefilter already bounds staff to their own and shared rows, and History relies on every retired key being listed
  const list = await ctx.tx.select().from(defs).where(conds.length ? and(...conds) : undefined).orderBy(desc(defs.updatedAt));
  return list.filter((row) => canSeeDefinition(ctx, row));
}

// ---------------------------------------------------------------- views

export interface DefinitionView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string;
  entity: string;
  entityLabel: string;
  spec: ReportSpec;
  defaultDateRange: string;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
  /** Staff only: the owner's id and name (null for a portal caller). */
  ownerId?: string | null;
  ownerName: string | null;
  /** private | shared; null for a portal caller. */
  visibility: string | null;
  sharedRoleKeys?: string[];
  sharedTeamIds?: string[];
  portalVisible: boolean;
  cover: boolean;
  isActive: boolean;
  runCount: number;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  canEdit: boolean;
  canDelete: boolean;
  summaryLines: string[];
}

interface Names {
  users: Map<string, string>;
  customers: Map<string, string>;
  /** Role key → name and team id → name, for "shared with …". */
  roles: Map<string, string>;
  teams: Map<string, string>;
  /** Record id → name for the option and ref values the specs filter on. */
  labels: Map<string, string>;
}

/** id → name rows of one directory, under the caller's row policy. */
function lookupNames(tx: Tx, kind: LookupKind, ids: string[]): Promise<{ id: string; name: string }[]> {
  switch (kind) {
    case 'customer': return tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, ids));
    case 'site': return tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, ids));
    case 'service': return tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(inArray(schema.services.id, ids));
    case 'team': return tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, ids));
    case 'user': return tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids));
    case 'ciType': return tx.select({ id: schema.ciTypes.id, name: schema.ciTypes.name }).from(schema.ciTypes).where(inArray(schema.ciTypes.id, ids));
    default: return Promise.resolve([]);
  }
}

/** The names of the records the specs filter on: one select per directory, under the caller's own row policy (an unknown id keeps its id). */
async function specLabels(tx: Tx, pairs: { entity: EntityDef; spec: ReportSpec }[]): Promise<Map<string, string>> {
  const options = new Set<string>();
  const byLookup = new Map<LookupKind, Set<string>>();
  for (const { entity, spec } of pairs) {
    const l = filterLookups(entity, spec);
    l.options.forEach((id) => options.add(id));
    for (const [kind, list] of Object.entries(l.byLookup) as [LookupKind, string[]][]) {
      const set = byLookup.get(kind) ?? new Set<string>();
      list.forEach((id) => set.add(id));
      byLookup.set(kind, set);
    }
  }
  const labels = new Map<string, string>();
  // one client per transaction: run the lookups sequentially
  if (options.size) {
    const rows = await tx.select({ id: schema.configOptions.id, label: schema.configOptions.label }).from(schema.configOptions).where(inArray(schema.configOptions.id, [...options]));
    rows.forEach((r) => labels.set(r.id, r.label));
  }
  for (const [kind, set] of byLookup) {
    const rows = await lookupNames(tx, kind, [...set]);
    rows.forEach((r) => labels.set(r.id, r.name));
  }
  return labels;
}

/** Everything a view or a virtual definition names: owners, fixed customers, the share targets and the filter values. Portal callers get none of the internal names. */
async function namesFor(ctx: Ctx, list: DefinitionRow[]): Promise<Names> {
  const tx = ctx.tx;
  const empty = new Map<string, string>();
  const customerIds = [...new Set(list.map((r) => r.scopeCustomerId).filter((x): x is string => !!x))];
  const customers = customerIds.length ? await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const names: Names = { users: empty, customers: new Map(customers.map((c) => [c.id, c.name])), roles: empty, teams: empty, labels: empty };
  if (isCustomerUser(ctx)) return names;
  const userIds = [...new Set(list.map((r) => r.ownerId).filter((x): x is string => !!x))];
  const roleKeys = [...new Set(list.flatMap((r) => (r.visibility === 'shared' ? r.sharedRoleKeys : [])))];
  const teamIds = [...new Set(list.flatMap((r) => (r.visibility === 'shared' ? r.sharedTeamIds : [])))];
  const users = userIds.length ? await tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const roles = roleKeys.length ? await tx.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(and(inArray(schema.roles.key, roleKeys), eq(schema.roles.userType, 'msp'))) : [];
  const teams = teamIds.length ? await tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds)) : [];
  const pairs = list.flatMap((r) => {
    const entity = entityOf(r.entity);
    return entity ? [{ entity, spec: specOf(r) }] : [];
  });
  return { ...names, users: new Map(users.map((u) => [u.id, u.name])), roles: new Map(roles.map((r) => [r.key, r.name])), teams: new Map(teams.map((t) => [t.id, t.name])), labels: await specLabels(tx, pairs) };
}

const specOf = (row: DefinitionRow): ReportSpec => (row.spec && typeof row.spec === 'object' ? row.spec : ({ columns: [], filters: [], match: 'all', groupBy: [], aggregates: [], sort: null, dateField: null, rowLimit: null, chart: null } as ReportSpec));

/** The plain-English lines of a spec with record names instead of ids (one lookup round); the audit trail and the assistant's preview use it. */
export async function summaryLinesFor(ctx: Ctx, entity: EntityDef, spec: ReportSpec): Promise<string[]> {
  if (isCustomerUser(ctx)) return describeSpec(entity, spec, { hideValues: true });
  return describeSpec(entity, spec, { labels: await specLabels(ctx.tx, [{ entity, spec }]) });
}

const sharedWithOf = (row: DefinitionRow, names: Names): string[] => (row.visibility === 'shared' ? [...row.sharedRoleKeys.map((k) => names.roles.get(k) ?? k), ...row.sharedTeamIds.map((id) => names.teams.get(id) ?? 'a team')] : []);

function toView(ctx: Ctx, row: DefinitionRow, names: Names): DefinitionView {
  const portal = isCustomerUser(ctx);
  const entity = entityOf(row.entity);
  const spec = specOf(row);
  const base: DefinitionView = {
    id: row.id,
    key: customKey(row.id),
    name: row.name,
    description: row.description,
    category: row.category,
    entity: row.entity,
    entityLabel: entity?.label ?? row.entity,
    // a portal caller learns which fields a report filters on, never the values (other organisations' ids, staff ids)
    spec: portal ? { ...spec, filters: spec.filters.map((flt) => ({ field: flt.field, op: flt.op })) } : spec,
    defaultDateRange: row.defaultDateRange,
    scopeCustomerId: row.scopeCustomerId,
    scopeCustomerName: row.scopeCustomerId ? names.customers.get(row.scopeCustomerId) ?? null : null,
    ownerName: portal ? null : row.ownerId ? names.users.get(row.ownerId) ?? null : null,
    visibility: portal ? null : row.visibility,
    portalVisible: row.portalVisible,
    cover: row.cover,
    isActive: row.isActive,
    runCount: row.runCount,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canEdit: canEditDefinition(ctx, row),
    canDelete: canDeleteDefinition(ctx, row),
    summaryLines: entity ? describeSpec(entity, spec, portal ? { hideValues: true } : { labels: names.labels }) : [],
  };
  // staff names and sharing are internal: never sent to the portal
  if (portal) return base;
  return { ...base, ownerId: row.ownerId, sharedRoleKeys: row.sharedRoleKeys, sharedTeamIds: row.sharedTeamIds };
}

function requireListAccess(ctx: Ctx) {
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:reports', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:reports');
  } else ctx.require('reports:run');
}

/** The definitions the caller may see and whose entity they may read; retired ones only for reports:manage with `includeInactive`. */
export async function listDefinitions(ctx: Ctx, q: ListQuery = {}): Promise<{ items: DefinitionView[]; total: number }> {
  requireListAccess(ctx);
  if (q.includeInactive && !ctx.can('reports:manage')) throw new ForbiddenError('Missing permission: reports:manage');
  const list = (await visibleDefinitionRows(ctx, { includeInactive: q.includeInactive, entity: q.entity, mine: q.mine, q: q.q })).filter((row) => {
    const entity = entityOf(row.entity);
    return entity && entityPermitted(ctx, entity);
  });
  const names = await namesFor(ctx, list);
  const items = list.map((row) => toView(ctx, row, names));
  return { items, total: items.length };
}

async function loadRow(ctx: Ctx, id: string): Promise<DefinitionRow> {
  if (!UUID_RE.test(id)) throw new NotFoundError('Report');
  const [row] = await ctx.tx.select().from(defs).where(eq(defs.id, id)).limit(1);
  if (!row || !canSeeDefinition(ctx, row)) throw new NotFoundError('Report');
  if (!row.isActive && !canEditDefinition(ctx, row)) throw new NotFoundError('Report');
  return row;
}

export async function getDefinition(ctx: Ctx, id: string): Promise<DefinitionView> {
  requireListAccess(ctx);
  const row = await loadRow(ctx, id);
  const entity = entityOrThrow(row.entity);
  if (!entityPermitted(ctx, entity)) {
    if (isCustomerUser(ctx)) throw new NotFoundError('Report');
    throw new ForbiddenError(`Missing permission: ${entity.permissions.join(', ')}`);
  }
  return toView(ctx, row, await namesFor(ctx, [row]));
}

// ---------------------------------------------------------------- validation shared by create and update

interface Validated {
  entity: EntityDef;
  spec: ReportSpec;
  sharedRoleKeys: string[];
  sharedTeamIds: string[];
}

async function validateDefinition(ctx: Ctx, input: DefinitionInput, limits: BuilderLimits): Promise<Validated> {
  const entity = entityOrThrow(input.entity);
  if (input.scopeCustomerId) ctx.requireCustomer(input.scopeCustomerId);
  for (const p of entity.permissions) ctx.require(p, input.scopeCustomerId);
  const spec = validateSpec(entity, input.spec, { portal: false, maxRows: limits.maxRows });
  if (input.portalVisible) validateSpec(entity, spec, { portal: true, maxRows: limits.maxRows });
  if (!(DATE_RANGE_PRESETS as readonly string[]).includes(input.defaultDateRange) || input.defaultDateRange === 'custom') throw new ValidationError('defaultDateRange must be a named preset');
  if (input.visibility === 'private') return { entity, spec, sharedRoleKeys: [], sharedTeamIds: [] };
  const keys = [...new Set(input.sharedRoleKeys)];
  const ids = [...new Set(input.sharedTeamIds)];
  if (keys.length) {
    const found = await ctx.tx.select({ key: schema.roles.key }).from(schema.roles).where(and(inArray(schema.roles.key, keys), eq(schema.roles.userType, 'msp')));
    const missing = keys.filter((k) => !found.some((r) => r.key === k));
    if (missing.length) throw new ValidationError(`Unknown staff role(s): ${missing.join(', ')}`);
  }
  if (ids.length) {
    const found = await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(inArray(schema.teams.id, ids));
    if (found.length !== ids.length) throw new ValidationError('One of the teams to share with does not exist');
  }
  return { entity, spec, sharedRoleKeys: keys, sharedTeamIds: ids };
}

const rowToInput = (row: DefinitionRow): DefinitionInput => ({ name: row.name, description: row.description, category: row.category as DefinitionInput['category'], entity: row.entity as EntityKey, spec: specOf(row), defaultDateRange: row.defaultDateRange as DateRangePreset, scopeCustomerId: row.scopeCustomerId, visibility: row.visibility as 'private' | 'shared', sharedRoleKeys: row.sharedRoleKeys, sharedTeamIds: row.sharedTeamIds, portalVisible: row.portalVisible, cover: row.cover, isActive: row.isActive });

const auditMeta = (entity: EntityDef, spec: ReportSpec, input: { visibility: string; portalVisible: boolean }) => ({ entity: entity.key, grouped: spec.groupBy.length > 0, columns: spec.groupBy.length ? spec.groupBy.length + spec.aggregates.length : spec.columns.length, filters: spec.filters.length, visibility: input.visibility, portalVisible: input.portalVisible });

/** Saving and copying need reports:build; never a portal user. */
function requireBuilder(ctx: Ctx) {
  if (isCustomerUser(ctx)) throw new ForbiddenError(PORTAL_MESSAGE);
  ctx.require('reports:build');
}

/** Reading the catalogue and previewing: reports:build, or reports:manage (who may edit anyone's report and therefore needs the editor to work). */
function requireBuilderAccess(ctx: Ctx) {
  if (isCustomerUser(ctx)) throw new ForbiddenError(PORTAL_MESSAGE);
  if (!ctx.can('reports:build') && !ctx.can('reports:manage')) throw new ForbiddenError('Missing permission: reports:build');
}

/** How many schedules (active or paused) point at a definition. */
async function scheduleCount(tx: Tx, id: string): Promise<number> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.reportSchedules).where(eq(schema.reportSchedules.reportKey, customKey(id)));
  return n;
}

// ---------------------------------------------------------------- CRUD

export async function createDefinition(ctx: Ctx, input: DefinitionInput): Promise<DefinitionView> {
  requireBuilder(ctx);
  const limits = await loadBuilderLimits(ctx.tx);
  const v = await validateDefinition(ctx, input, limits);
  const [row] = await ctx.tx
    .insert(defs)
    .values({ name: input.name, description: input.description ?? null, category: input.category, entity: input.entity, spec: v.spec, defaultDateRange: input.defaultDateRange, scopeCustomerId: input.scopeCustomerId, ownerId: ctx.user.apiKeyId ? null : ctx.user.id, visibility: input.visibility, sharedRoleKeys: v.sharedRoleKeys, sharedTeamIds: v.sharedTeamIds, portalVisible: input.portalVisible, cover: input.cover, isActive: input.isActive })
    .returning();
  await ctx.audit({ entityType: 'report_definition', entityId: row!.id, entityLabel: row!.name, action: 'create', customerId: row!.scopeCustomerId, metadata: { ...auditMeta(v.entity, v.spec, input), summary: await summaryLinesFor(ctx, v.entity, v.spec) } });
  return toView(ctx, row!, await namesFor(ctx, [row!]));
}

const AUDITED_FIELDS = ['name', 'description', 'category', 'entity', 'defaultDateRange', 'visibility', 'sharedRoleKeys', 'sharedTeamIds', 'portalVisible', 'scopeCustomerId', 'cover', 'isActive'] as const;

export async function updateDefinition(ctx: Ctx, id: string, patch: DefinitionPatch): Promise<DefinitionView> {
  if (isCustomerUser(ctx)) throw new ForbiddenError(PORTAL_MESSAGE);
  const before = await loadRow(ctx, id);
  if (!canEditDefinition(ctx, before)) throw new ForbiddenError('You may not edit this report');
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as DefinitionPatch;
  const merged: DefinitionInput = { ...rowToInput(before), ...clean } as DefinitionInput;
  // retiring and restoring are the delete right, not the edit right; a scheduled report cannot be retired through a patch either
  if (clean.isActive !== undefined && clean.isActive !== before.isActive) {
    if (!canDeleteDefinition(ctx, before)) throw new ForbiddenError('Only the owner or a report manager may retire or restore this report');
    if (!clean.isActive) {
      const n = await scheduleCount(ctx.tx, id);
      if (n > 0) throw new ConflictError(`Delete the ${n} schedule(s) using this report first`);
    }
  }
  // fixing the report to one customer must not strand schedules that target another customer or every customer
  if (merged.scopeCustomerId && merged.scopeCustomerId !== before.scopeCustomerId) {
    const stranded = await ctx.tx.select({ id: schema.reportSchedules.id, name: schema.reportSchedules.name, customerId: schema.reportSchedules.customerId, filters: schema.reportSchedules.filters }).from(schema.reportSchedules).where(eq(schema.reportSchedules.reportKey, customKey(id)));
    const conflicting = stranded.filter((x) => (x.customerId && x.customerId !== merged.scopeCustomerId) || x.filters?.perCustomer === true);
    if (conflicting.length) throw new ConflictError(`Change or delete the schedule(s) ${conflicting.map((x) => `"${x.name}"`).join(', ')} first: they run this report for another customer`);
  }
  const limits = await loadBuilderLimits(ctx.tx);
  const v = await validateDefinition(ctx, merged, limits);
  const [row] = await ctx.tx
    .update(defs)
    .set({ name: merged.name, description: merged.description ?? null, category: merged.category, entity: merged.entity, spec: v.spec, defaultDateRange: merged.defaultDateRange, scopeCustomerId: merged.scopeCustomerId, visibility: merged.visibility, sharedRoleKeys: v.sharedRoleKeys, sharedTeamIds: v.sharedTeamIds, portalVisible: merged.portalVisible, cover: merged.cover, isActive: merged.isActive, updatedAt: new Date() })
    .where(eq(defs.id, id))
    .returning();
  const after = row!;
  const pick = (r: DefinitionRow) => Object.fromEntries(AUDITED_FIELDS.map((k) => [k, r[k]]));
  const specChanged = JSON.stringify(specOf(before)) !== JSON.stringify(after.spec);
  await ctx.audit({ entityType: 'report_definition', entityId: id, entityLabel: after.name, action: 'update', customerId: after.scopeCustomerId, changes: diffChanges(pick(before), pick(after)), metadata: { ...auditMeta(v.entity, v.spec, merged), specChanged, ...(specChanged ? { summary: await summaryLinesFor(ctx, v.entity, v.spec) } : {}) } });
  return toView(ctx, after, await namesFor(ctx, [after]));
}

/** Retires a definition (`is_active = false`): it leaves the catalogue; its past runs stay in History. Schedules must go first. */
export async function deleteDefinition(ctx: Ctx, id: string): Promise<{ ok: true }> {
  if (isCustomerUser(ctx)) throw new ForbiddenError(PORTAL_MESSAGE);
  const row = await loadRow(ctx, id);
  if (!canDeleteDefinition(ctx, row)) throw new ForbiddenError('Only the owner or a report manager may delete this report');
  const n = await scheduleCount(ctx.tx, id);
  if (n > 0) throw new ConflictError(`Delete the ${n} schedule(s) using this report first`);
  await ctx.tx.update(defs).set({ isActive: false, updatedAt: new Date() }).where(eq(defs.id, id));
  await ctx.audit({ entityType: 'report_definition', entityId: id, entityLabel: row.name, action: 'delete', customerId: row.scopeCustomerId, metadata: { entity: row.entity, retired: true } });
  return { ok: true };
}

export async function duplicateDefinition(ctx: Ctx, id: string): Promise<DefinitionView> {
  requireBuilder(ctx);
  const row = await loadRow(ctx, id);
  const entity = entityOrThrow(row.entity);
  if (!entityPermitted(ctx, entity)) throw new ForbiddenError(`Missing permission: ${entity.permissions.join(', ')}`);
  if (row.scopeCustomerId) ctx.requireCustomer(row.scopeCustomerId);
  const [copy] = await ctx.tx
    .insert(defs)
    .values({ name: `${row.name} (copy)`.slice(0, 160), description: row.description, category: row.category, entity: row.entity, spec: specOf(row), defaultDateRange: row.defaultDateRange, scopeCustomerId: row.scopeCustomerId, ownerId: ctx.user.apiKeyId ? null : ctx.user.id, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: row.cover, isActive: true })
    .returning();
  await ctx.audit({ entityType: 'report_definition', entityId: copy!.id, entityLabel: copy!.name, action: 'create', customerId: copy!.scopeCustomerId, metadata: { ...auditMeta(entity, specOf(row), { visibility: 'private', portalVisible: false }), copiedFrom: row.id } });
  return toView(ctx, copy!, await namesFor(ctx, [copy!]));
}

// ---------------------------------------------------------------- execution

/** A cancelled statement (statement_timeout) becomes a clear validation error; anything else is rethrown. */
export function mapQueryError(err: unknown, timeoutMs: number): unknown {
  const code = (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause?.code ?? null);
  if (code === '57014') return new ValidationError(`This report took longer than ${Math.round(timeoutMs / 1000)} seconds; add a filter or shorten the period`);
  return err;
}

/**
 * Runs `fn` inside a savepoint with its own statement time limit. A cancelled
 * statement aborts only the savepoint, so the enclosing transaction (the run row,
 * the worker's failure path) stays usable; the limit is reset afterwards.
 */
export async function withStatementTimeout<T>(ctx: Ctx, timeoutMs: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ms = Math.max(1000, Math.min(120_000, Math.round(timeoutMs)));
  await ctx.tx.execute(sql`SAVEPOINT report_query`);
  try {
    await ctx.tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
    const out = await fn(ctx.tx);
    await ctx.tx.execute(sql`RELEASE SAVEPOINT report_query`);
    return out;
  } catch (err) {
    await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT report_query`);
    await ctx.tx.execute(sql`RELEASE SAVEPOINT report_query`);
    throw mapQueryError(err, ms);
  } finally {
    await ctx.tx.execute(sql`SET LOCAL statement_timeout = DEFAULT`).catch(() => undefined);
  }
}

interface ExecOptions {
  limit: number;
  timeoutMs: number;
  portal: boolean;
  name: string;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Compiles and runs a validated spec: rows, the true row count, summary tiles and the chart. */
async function executeSpec(ctx: Ctx, entity: EntityDef, spec: ReportSpec, params: { customerId: string | null; from: string; to: string }, opts: ExecOptions): Promise<ReportResult & { rowCount: number }> {
  const compiled = compileSpec(ctx, entity, spec, params, { limit: opts.limit, portal: opts.portal });
  const list = await withStatementTimeout(ctx, opts.timeoutMs, async (tx) => {
    const started = Date.now();
    const data = await queryRows<Record<string, unknown>>(ctx, compiled.sql);
    if (data.length < opts.limit) return { data, total: data.length };
    // the limit covers the run as a whole: the count (only when the rows were capped) gets what the row query left, with a second at least
    const remaining = Math.max(1000, Math.round(opts.timeoutMs - (Date.now() - started)));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${remaining}`));
    const total = Number(((await queryRows<{ n: number }>(ctx, compiled.countSql))[0] ?? { n: data.length }).n);
    return { data, total };
  });
  const summary: ReportResult['summary'] = [{ label: 'Rows', value: list.total }];
  const charts: ReportChart[] = [];
  if (compiled.grouped) {
    for (const a of spec.aggregates) {
      const alias = aggregateAlias(a);
      const label = compiled.columns.find((c) => c.key === alias)?.label ?? alias;
      const values = list.data.map((r) => num(r[alias])).filter((v): v is number => v !== null && Number.isFinite(v));
      let value: number | null = null;
      if (values.length) {
        if (a.fn === 'count' || a.fn === 'sum') value = round1(values.reduce((s, v) => s + v, 0));
        else if (a.fn === 'avg') value = round1(values.reduce((s, v) => s + v, 0) / values.length);
        else if (a.fn === 'min') value = Math.min(...values);
        else value = Math.max(...values);
      }
      summary.push({ label, value, hint: a.fn === 'avg' ? 'average of the groups' : a.fn === 'min' || a.fn === 'max' ? 'across the groups' : 'all groups' });
    }
    if (spec.chart) {
      const labels = Object.fromEntries(spec.chart.y.map((y) => [y, compiled.columns.find((c) => c.key === y)?.label ?? y]));
      const data = list.data.slice(0, 50).map((r) => ({ ...r, label: spec.groupBy.map((g) => (r[g] === null || r[g] === undefined || r[g] === '' ? '(none)' : String(r[g]))).join(' · ') }));
      charts.push({ type: spec.chart.type, title: opts.name, data, x: 'label', y: spec.chart.y, labels });
    }
  }
  return { columns: compiled.columns, rows: list.data, summary, charts, truncated: list.total > list.data.length, rowCount: list.total };
}

/**
 * The executor behind the virtual definition. The row's customer scope wins over
 * the run parameter; a customer user's spec is re-checked against the portal rules
 * at run time so a later edit of a published report cannot slip an internal field in.
 */
export async function runSpec(ctx: Ctx, row: DefinitionRow, params: ReportParams, opts: { limit?: number; preview?: boolean } = {}): Promise<ReportResult> {
  const entity = entityOrThrow(row.entity);
  const limits = await loadBuilderLimits(ctx.tx);
  const portal = isCustomerUser(ctx);
  // a saved row limit above a lowered reports.builder.max_rows is clamped, not refused: the cap is the operator's, the report keeps running
  const stored = specOf(row);
  const spec = validateSpec(entity, { ...stored, rowLimit: stored.rowLimit === null ? null : Math.min(stored.rowLimit, limits.maxRows) }, { portal, maxRows: limits.maxRows });
  const customerId = row.scopeCustomerId ?? params.customerId;
  if (customerId && !ctx.user.isSystem && !portal) ctx.requireCustomer(customerId);
  const result = await executeSpec(ctx, entity, spec, { customerId, from: params.from, to: params.to }, { limit: Math.min(opts.limit ?? limits.maxRows, limits.maxRows), timeoutMs: limits.statementTimeoutMs, portal, name: row.name });
  // the row is an MSP artefact: customer users may read it but never write it (RLS), so their runs are not counted
  if (!opts.preview && !portal) await ctx.tx.update(defs).set({ runCount: sql`${defs.runCount} + 1`, lastRunAt: new Date() }).where(eq(defs.id, row.id));
  return result;
}

/** The builder's live preview: validated, run with the preview cap, never stored as a run; audited. */
export async function preview(ctx: Ctx, body: PreviewBody, opts: { limit?: number } = {}): Promise<ReportResult & { rowCount: number; period: DateRange; summaryLines: string[] }> {
  requireBuilderAccess(ctx);
  const entity = entityOrThrow(body.entity);
  for (const p of entity.permissions) ctx.require(p);
  const limits = await loadBuilderLimits(ctx.tx);
  const spec = validateSpec(entity, body.spec, { portal: body.portal, maxRows: limits.maxRows });
  const customerId = resolveCustomerId(ctx, body.parameters);
  const raw = body.parameters;
  const period = resolveDateRange(typeof raw.dateRange === 'string' ? raw.dateRange : 'last_30_days', { from: typeof raw.from === 'string' ? raw.from : null, to: typeof raw.to === 'string' ? raw.to : null }, todayIn(ctx.user.timezone ?? 'UTC'));
  const result = await executeSpec(ctx, entity, spec, { customerId, from: period.from, to: period.to }, { limit: Math.max(1, Math.min(limits.previewRows, opts.limit ?? limits.previewRows)), timeoutMs: limits.statementTimeoutMs, portal: body.portal, name: 'Preview' });
  await ctx.audit({ entityType: 'report_definition', action: 'preview', customerId, metadata: { entity: entity.key, grouped: spec.groupBy.length > 0, filters: spec.filters.length, rows: result.rowCount } });
  return { ...result, period, summaryLines: await summaryLinesFor(ctx, entity, spec) };
}

// ---------------------------------------------------------------- the virtual definition

/** The registry entry of a stored row: it runs through the same executor, renderers and schedules as a built-in. */
export function toDefinition(ctx: Ctx, row: DefinitionRow, entity: EntityDef, names: Names): CustomDefinition {
  const spec = specOf(row);
  const portal = isCustomerUser(ctx);
  const summaryLines = describeSpec(entity, spec, portal ? { hideValues: true } : { labels: names.labels });
  return {
    key: customKey(row.id),
    name: row.name,
    description: row.description ?? summaryLines.join('; '),
    category: row.category as ReportCategory,
    permissions: entity.permissions,
    portal: row.portalVisible && entity.portal,
    parameters: [...(row.scopeCustomerId ? [] : [customerParam]), ...(spec.dateField ? [dateRangeParam] : [])],
    defaultDateRange: row.defaultDateRange as DateRangePreset,
    cover: row.cover,
    custom: { id: row.id, entity: row.entity, ownerName: portal ? null : row.ownerId ? names.users.get(row.ownerId) ?? null : null, visibility: portal ? null : row.visibility, sharedWith: portal ? null : sharedWithOf(row, names), portalVisible: row.portalVisible, canEdit: canEditDefinition(ctx, row), isActive: row.isActive, scopeCustomerId: row.scopeCustomerId, summaryLines },
    run: (runCtx, params) => runSpec(runCtx, row, params),
  };
}

/** `custom:<uuid>` → the definition when the row exists, is active and visible; otherwise null (a retired report cannot run, not even for the worker). */
export async function loadCustomDefinition(ctx: Ctx, key: string): Promise<ReportDefinition | null> {
  const id = customIdOf(key);
  if (!id || !UUID_RE.test(id)) return null;
  const [row] = await ctx.tx.select().from(defs).where(eq(defs.id, id)).limit(1);
  if (!row || !row.isActive || !canSeeDefinition(ctx, row)) return null;
  const entity = entityOf(row.entity);
  if (!entity) return null;
  return toDefinition(ctx, row, entity, await namesFor(ctx, [row]));
}

/** Every custom definition the caller may see (the registry filters them by entity permission). */
export async function visibleDefinitions(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<ReportDefinition[]> {
  const list = await visibleDefinitionRows(ctx, opts);
  const names = await namesFor(ctx, list);
  const out: ReportDefinition[] = [];
  for (const row of list) {
    const entity = entityOf(row.entity);
    if (entity) out.push(toDefinition(ctx, row, entity, names));
  }
  return out;
}

// ---------------------------------------------------------------- the catalogue

export interface BuilderCatalog {
  entities: PublicEntity[];
  operators: typeof OPERATORS;
  operatorLabels: typeof OPERATOR_LABELS;
  presets: DateRangePreset[];
  limits: { maxRows: number; previewRows: number };
  shareTargets: { roles: { key: string; name: string }[]; teams: { id: string; name: string }[] };
}

/** What the builder page needs: entities and fields (no SQL), operators, presets, limits and who a report can be shared with. */
export async function catalog(ctx: Ctx): Promise<BuilderCatalog> {
  requireBuilderAccess(ctx);
  const limits = await loadBuilderLimits(ctx.tx);
  const roles = await ctx.tx.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(and(eq(schema.roles.userType, 'msp'), sql`${schema.roles.key} <> 'admin'`)).orderBy(schema.roles.name);
  const teams = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.isActive, true)).orderBy(schema.teams.name);
  return { ...catalogFor(ctx, { portal: false }), operators: OPERATORS, operatorLabels: OPERATOR_LABELS, presets: DATE_RANGE_PRESETS.filter((p) => p !== 'custom'), limits: { maxRows: limits.maxRows, previewRows: limits.previewRows }, shareTargets: { roles, teams } };
}

export { ENTITIES, catalogFor, OPERATORS, validateSpec, describeSpec };

// The registry never imports the database: it learns about stored definitions through these hooks.
setCustomLoader(loadCustomDefinition);
setCustomLister(visibleDefinitions);
