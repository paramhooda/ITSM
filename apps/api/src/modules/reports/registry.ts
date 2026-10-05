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
  /** Printed totals row: sum or mean of this column (only when declared; never inferred). */
  total?: 'sum' | 'avg';
}

export type ChartType = 'bar' | 'line' | 'stacked_bar' | 'donut' | 'heatmap' | 'gauge';
export type ValueUnit = 'count' | 'pct' | 'minutes' | 'hours' | 'rating';
export type InsightRule = 'concentration' | 'extremes' | 'outliers';

export interface ReportChart {
  type: ChartType;
  title: string;
  subtitle?: string;
  data: Record<string, unknown>[];
  x: string;
  /** One or more series keys. */
  y: string | string[];
  /** Optional display labels per series key. */
  labels?: Record<string, string>;
  /** Value unit for axis ticks and direct labels. */
  unit?: ValueUnit;
  /** bar: horizontal when true (chosen automatically for long labels or more than 8 bars). */
  horizontal?: boolean;
  /** One category or series drawn in the first categorical hue while the rest go de-emphasis gray. */
  emphasis?: string;
  /** gauge: the target drawn as a tick; bar/line with unit pct: a solid hairline target. */
  target?: number;
  /** heatmap: data rows are { row, col, value }; rows/cols fix the order (weekdays, hours). */
  rows?: string[];
  cols?: string[];
  /** Printed width; charts default to half (two per row). */
  width?: 'half' | 'full';
  /** Which insight rules may read this chart; 'none' switches them off. Defaults: bar: concentration and extremes; line: outliers. */
  insight?: InsightRule[] | 'none';
  /** Series keys met/completed/good wear the good status colour, breached/failed/missed/backed_out the critical one, warning the warning one, anything else the de-emphasis gray. */
  statusSeries?: boolean;
}

export interface TileDelta {
  previous: number | null;
  change: number | null;
  deltaPct: number | null;
  lowerIsBetter?: boolean;
  unit?: ValueUnit;
  /** A move that is neither good nor bad (demand, record counts): printed in gray. */
  neutral?: boolean;
}

export interface SummaryTile {
  label: string;
  value: string | number | null;
  hint?: string;
  /** How a numeric value is printed (96.4 as "96.4%", 42 as "42 min", 4.2 as "4.2/5"); inferred from the label by attachDeltas when absent. */
  unit?: ValueUnit;
  /** Previous period value and the signed change; `lowerIsBetter` decides the badge colour. */
  delta?: TileDelta;
  /** Twelve or fewer points for a sparkline. */
  spark?: (number | null)[];
  /** A target the value is judged against (SLA 95, CSAT 4). */
  target?: number;
  tone?: 'good' | 'warn' | 'bad';
}

export interface Insight {
  kind: 'good' | 'attention' | 'info';
  area: string;
  text: string;
  evidence?: string;
  weight: number;
}
export interface Recommendation {
  area: string;
  recommendation: string;
  evidence: string;
}
export interface Narrative {
  summary: string;
  wentWell: string[];
  needsAttention: string[];
  nextSteps: string[];
  source: 'rules' | 'model';
}
export interface Glossary {
  term: string;
  meaning: string;
}

export interface ReportSection {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  /** Chapter heading: consecutive sections sharing a `group` print under one heading with the section title beneath; the cover contents list the groups. Excel and CSV ignore it. */
  group?: string;
  /** One line under the heading. */
  intro?: string;
  /** Print the totals row (uses the columns' `total`). */
  totals?: boolean;
  /** Rows printed in HTML and PDF before the "full list in Excel" note (default 50 for packs, 500 otherwise). */
  printLimit?: number;
  /** Charts that belong to this section (printed above its table). */
  charts?: ReportChart[];
  callouts?: Insight[];
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  summary?: SummaryTile[];
  charts?: ReportChart[];
  /** Additional tables (breached list, consumption detail...). */
  sections?: ReportSection[];
  truncated?: boolean;
  /** The true number of matching rows when `rows` was capped (custom reports); absent when every row is present. */
  rowCount?: number;
  /** Filled by executeReport (deriveInsights) unless the definition provides its own. */
  insights?: Insight[];
  recommendations?: Recommendation[];
  /** Filled by executeReport: the rules' phrasing, or the model's rephrasing when it is on. */
  narrative?: Narrative;
  glossary?: Glossary[];
  /** Free-text data notes printed in the appendix (the renderer adds the standard ones). */
  notes?: string[];
  /** Set by executeReport when a comparison against the previous period ran. */
  comparison?: { from: string; to: string; label: string };
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
  /** Run the definition a second time for the previous period of the same length and attach deltas to numeric tiles. Defaults to true when the definition has a `daterange` parameter. */
  compare?: boolean;
  /** 'pack' documents title the detail table Scorecard and cap section tables at the print row setting. */
  kind?: 'report' | 'pack';
  glossary?: Glossary[];
  run(ctx: Ctx, params: ReportParams): Promise<ReportResult>;
}

/** Whether a definition is compared against the previous period (its own flag, else whenever it takes a date range). */
export const comparesPeriods = (d: ReportDefinition) => d.compare ?? d.parameters.some((p) => p.type === 'daterange');

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
  kind: d.kind ?? 'report',
  compare: comparesPeriods(d),
  ...(isCustomDefinition(d) ? { custom: d.custom } : {}),
});
