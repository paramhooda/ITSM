import type { Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import type { DateRangePreset } from './dates';

export const REPORT_CATEGORIES = ['tickets', 'sla', 'customers', 'contracts', 'assets', 'cmdb', 'amc', 'field', 'pm', 'noc', 'soc', 'scope', 'audit', 'custom'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export type ParameterType = 'customer' | 'daterange' | 'select' | 'multiselect' | 'boolean' | 'text' | 'number';

export interface ReportParameter {
  key: string;
  label: string;
  type: ParameterType;
  /** Static choices for select/multiselect. */
  options?: { value: string; label: string }[];
  /** Config option type (or `ci_type`, `service`, `team`) the UI resolves into choices. */
  optionType?: string;
  required?: boolean;
  default?: unknown;
  help?: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  type?: 'date' | 'datetime' | 'number' | 'pct' | 'minutes' | 'text' | 'boolean';
}

export interface ReportChart {
  type: 'bar' | 'line';
  title: string;
  data: Record<string, unknown>[];
  x: string;
  /** One or more series keys. */
  y: string | string[];
  /** Optional display labels per series key. */
  labels?: Record<string, string>;
}

export interface ReportSection {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  summary?: { label: string; value: string | number | null; hint?: string }[];
  charts?: ReportChart[];
  /** Additional tables (breached list, consumption detail...). */
  sections?: ReportSection[];
  truncated?: boolean;
  /** The true number of matching rows when `rows` was capped (custom reports); absent when every row is present. */
  rowCount?: number;
}

/** Normalized parameters every definition receives (plus its own keys). */
export interface ReportParams {
  customerId: string | null;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface ReportDefinition {
  key: string;
  name: string;
  description: string;
  category: ReportCategory;
  /** All listed permissions are required for MSP users (`reports:run` is implied). */
  permissions: Permission[];
  /** Available to customer portal users (always fixed to their own customer). */
  portal: boolean;
  parameters: ReportParameter[];
  defaultDateRange?: DateRangePreset;
  /** Open HTML and PDF output with a branded cover page (review packs). */
  cover?: boolean;
  run(ctx: Ctx, params: ReportParams): Promise<ReportResult>;
}

/** What a custom (builder) definition carries beyond a built-in one; set by the builder's toDefinition. */
export interface CustomInfo {
  id: string;
  entity: string;
  /** null for a portal caller (staff names are internal). */
  ownerName: string | null;
  /** private | shared; null for a portal caller. */
  visibility: string | null;
  /** The names of the roles and teams a shared report reaches; null for a portal caller. */
  sharedWith: string[] | null;
  portalVisible: boolean;
  canEdit: boolean;
  isActive: boolean;
  scopeCustomerId: string | null;
  summaryLines: string[];
}
export type CustomDefinition = ReportDefinition & { custom: CustomInfo };
export const isCustomDefinition = (d: ReportDefinition): d is CustomDefinition => !!(d as CustomDefinition).custom;

/** Hard cap on rows a definition may return (definitions also LIMIT in SQL). */
export const MAX_REPORT_ROWS = 50_000;

const registry = new Map<string, ReportDefinition>();

export function registerReport(def: ReportDefinition) {
  if (registry.has(def.key)) throw new Error(`Report ${def.key} already registered`);
  registry.set(def.key, def);
  return def;
}

export const allReports = () => [...registry.values()];
/** A built-in definition by key (custom keys resolve through resolveReport). */
export const findReport = (key: string) => registry.get(key) ?? null;

export const CUSTOM_PREFIX = 'custom:';
export const isCustomKey = (key: string) => key.startsWith(CUSTOM_PREFIX);

/**
 * Custom definitions live in the database; the registry never imports it, so the
 * reports service wires a loader (one key) and a lister (every definition the
 * caller may see) at module level.
 */
type CustomLoader = (ctx: Ctx, key: string) => Promise<ReportDefinition | null>;
type CustomLister = (ctx: Ctx, opts?: { includeInactive?: boolean }) => Promise<ReportDefinition[]>;
let customLoader: CustomLoader | null = null;
let customLister: CustomLister | null = null;
export const setCustomLoader = (fn: CustomLoader | null) => {
  customLoader = fn;
};
export const setCustomLister = (fn: CustomLister | null) => {
  customLister = fn;
};

/** A built-in definition by key, or a custom one the caller may see (null when neither). */
export async function resolveReport(ctx: Ctx, key: string): Promise<ReportDefinition | null> {
  const builtIn = findReport(key);
  if (builtIn) return builtIn;
  if (customLoader && isCustomKey(key)) return customLoader(ctx, key);
  return null;
}

export const isCustomerUser = (ctx: Ctx) => ctx.user.userType === 'customer';

/** The customer a run is for: customer users are pinned to their own organisation; staff may pass one they can see. */
export function resolveCustomerId(ctx: Ctx, raw: Record<string, unknown>): string | null {
  if (isCustomerUser(ctx)) {
    if (!ctx.user.customerId) throw new ForbiddenError('Customer context required');
    return ctx.user.customerId;
  }
  const v = raw.customerId;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new ValidationError('Invalid customerId');
  ctx.requireCustomer(v);
  return v;
}

/** May this principal run the definition (for an optional customer)? */
export function canRunReport(ctx: Ctx, def: ReportDefinition, customerId?: string | null): boolean {
  if (ctx.user.isSystem) return true;
  if (isCustomerUser(ctx)) return def.portal && ctx.can('portal:reports', ctx.user.customerId);
  if (!ctx.can('reports:run', customerId)) return false;
  return def.permissions.every((p) => ctx.can(p, customerId));
}

export async function requireReport(ctx: Ctx, key: string, customerId?: string | null): Promise<ReportDefinition> {
  const def = await resolveReport(ctx, key);
  if (!def) throw new NotFoundError('Report');
  if (!canRunReport(ctx, def, customerId)) {
    if (isCustomerUser(ctx)) throw new NotFoundError('Report');
    throw new ForbiddenError(`Missing permission to run report ${def.name}`);
  }
  return def;
}

/** Built-ins the caller may run, then the custom definitions visible to them (retired ones only with `includeInactive`). */
export async function visibleReports(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<ReportDefinition[]> {
  const builtIns = allReports().filter((d) => canRunReport(ctx, d));
  const custom = customLister ? (await customLister(ctx, opts)).filter((d) => canRunReport(ctx, d)) : [];
  return [...builtIns, ...custom];
}

/** Public shape (no `run`). */
export const describeReport = (d: ReportDefinition) => ({
  key: d.key,
  name: d.name,
  description: d.description,
  category: d.category,
  permissions: d.permissions,
  portal: d.portal,
  parameters: d.parameters,
  defaultDateRange: d.defaultDateRange ?? 'last_30_days',
  cover: d.cover === true,
  ...(isCustomDefinition(d) ? { custom: d.custom } : {}),
});
