import type { Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError } from '@/core/errors';
import type { DateRangePreset } from './dates';

export const REPORT_CATEGORIES = ['tickets', 'sla', 'customers', 'contracts', 'assets', 'cmdb', 'amc', 'field', 'pm', 'noc', 'soc', 'scope', 'audit'] as const;
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

/** Hard cap on rows a definition may return (definitions also LIMIT in SQL). */
export const MAX_REPORT_ROWS = 50_000;

const registry = new Map<string, ReportDefinition>();

export function registerReport(def: ReportDefinition) {
  if (registry.has(def.key)) throw new Error(`Report ${def.key} already registered`);
  registry.set(def.key, def);
  return def;
}

export const allReports = () => [...registry.values()];
export const findReport = (key: string) => registry.get(key) ?? null;

export const isCustomerUser = (ctx: Ctx) => ctx.user.userType === 'customer';

/** May this principal run the definition (for an optional customer)? */
export function canRunReport(ctx: Ctx, def: ReportDefinition, customerId?: string | null): boolean {
  if (ctx.user.isSystem) return true;
  if (isCustomerUser(ctx)) return def.portal && ctx.can('portal:reports', ctx.user.customerId);
  if (!ctx.can('reports:run', customerId)) return false;
  return def.permissions.every((p) => ctx.can(p, customerId));
}

export function requireReport(ctx: Ctx, key: string, customerId?: string | null): ReportDefinition {
  const def = findReport(key);
  if (!def) throw new NotFoundError('Report');
  if (!canRunReport(ctx, def, customerId)) {
    if (isCustomerUser(ctx)) throw new NotFoundError('Report');
    throw new ForbiddenError(`Missing permission to run report ${def.name}`);
  }
  return def;
}

export const visibleReports = (ctx: Ctx) => allReports().filter((d) => canRunReport(ctx, d));

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
});
