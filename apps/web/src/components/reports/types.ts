export type ParameterType = 'customer' | 'daterange' | 'select' | 'multiselect' | 'boolean' | 'text' | 'number';
export interface ReportParameter { key: string; label: string; type: ParameterType; options?: { value: string; label: string }[]; optionType?: string; required?: boolean; default?: unknown; help?: string }
/** What a custom (builder) definition carries beyond a built-in one; ownerName and visibility are null for portal users. */
export interface CustomInfo { id: string; entity: string; ownerName: string | null; visibility: string | null; /** Names of the roles and teams a shared report reaches; null for portal users. */ sharedWith: string[] | null; portalVisible: boolean; canEdit: boolean; isActive: boolean; scopeCustomerId: string | null; summaryLines: string[] }
export interface ReportDefinition { key: string; name: string; description: string; category: string; permissions: string[]; portal: boolean; parameters: ReportParameter[]; defaultDateRange: string; cover?: boolean; /** 'pack' documents title the detail table Scorecard and cap their tables. */ kind?: 'report' | 'pack'; /** Compared with the previous period of the same length. */ compare?: boolean; custom?: CustomInfo }
/** File outputs of a run (json is the on-screen preview). */
export type FileFormat = 'csv' | 'html' | 'pdf' | 'xlsx';
export const SCHEDULE_FORMATS = (pdf: boolean) => [{ value: 'html', label: 'HTML (printable)' }, { value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: pdf ? 'PDF' : 'PDF (needs Chromium on the server)' }, { value: 'both', label: 'HTML + CSV' }, { value: 'pack', label: pdf ? 'PDF + Excel (review pack)' : 'PDF + Excel (needs Chromium on the server)' }];
export interface ReportColumn { key: string; label: string; type?: 'date' | 'datetime' | 'number' | 'pct' | 'minutes' | 'text' | 'boolean'; /** Printed totals row in the documents. */ total?: 'sum' | 'avg' }
export type ChartType = 'bar' | 'line' | 'stacked_bar' | 'donut' | 'heatmap' | 'gauge';
export type ValueUnit = 'count' | 'pct' | 'minutes' | 'hours' | 'rating';
export interface ReportChart { type: ChartType; title: string; subtitle?: string; data: Record<string, unknown>[]; x: string; y: string | string[]; labels?: Record<string, string>; unit?: ValueUnit; horizontal?: boolean; emphasis?: string; target?: number; /** heatmap: data rows are { row, col, value }. */ rows?: string[]; cols?: string[]; width?: 'half' | 'full'; statusSeries?: boolean }
export interface TileDelta { previous: number | null; change: number | null; deltaPct: number | null; lowerIsBetter?: boolean; unit?: ValueUnit; /** Neither good nor bad (demand, record counts). */ neutral?: boolean }
export interface SummaryTile { label: string; value: string | number | null; hint?: string; unit?: ValueUnit; delta?: TileDelta; spark?: (number | null)[]; target?: number; tone?: 'good' | 'warn' | 'bad' }
export interface Insight { kind: 'good' | 'attention' | 'info'; area: string; text: string; evidence?: string; weight: number }
export interface Recommendation { area: string; recommendation: string; evidence: string }
export interface Narrative { summary: string; wentWell: string[]; needsAttention: string[]; nextSteps: string[]; source: 'rules' | 'model' }
export interface Glossary { term: string; meaning: string }
export interface ReportSection { title: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; /** Chapter: consecutive sections sharing a group print under one heading. */ group?: string; intro?: string; totals?: boolean; printLimit?: number; charts?: ReportChart[]; callouts?: Insight[] }
export interface ReportResult { columns: ReportColumn[]; rows: Record<string, unknown>[]; summary?: SummaryTile[]; charts?: ReportChart[]; sections?: ReportSection[]; truncated?: boolean; rowCount: number; insights?: Insight[]; recommendations?: Recommendation[]; narrative?: Narrative; glossary?: Glossary[]; notes?: string[]; comparison?: { from: string; to: string; label: string } }

/** A tile value with its unit: 96.4 and pct give "96.4%", 42 and minutes "42 min", 4.2 and rating "4.2/5", 7.5 and hours "7.5 h" (the API rule); a label that already names the unit, such as "MTTR (min)", prints the bare number. */
export function fmtTileValue(t: Pick<SummaryTile, 'value' | 'unit'> & { label?: string }): string {
  if (t.value === null || t.value === undefined || t.value === '') return '—';
  if (typeof t.value !== 'number') return String(t.value);
  const v = t.value;
  if (t.label && /\((min|h|%)\)$/.test(t.label)) return Number.isInteger(v) ? v.toLocaleString('en-US') : (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const r1 = Math.round(v * 10) / 10;
  switch (t.unit) {
    case 'pct': return `${r1.toLocaleString('en-US')}%`;
    case 'minutes': return `${Math.round(v).toLocaleString('en-US')} min`;
    case 'hours': return `${r1.toLocaleString('en-US')} h`;
    case 'rating': return `${r1}/5`;
    default: return Number.isInteger(v) ? v.toLocaleString('en-US') : r1.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
}

/** "+4.3 pts" for percentage tiles, "+12%" otherwise, the absolute change when the previous value was zero (the API rule). */
export function fmtDelta(d?: TileDelta | null): string {
  if (!d || typeof d.change !== 'number' || !Number.isFinite(d.change)) return '—';
  const sign = d.change > 0 ? '+' : d.change < 0 ? '−' : '±';
  const abs = Math.abs(d.change);
  if (d.unit === 'pct') return `${sign}${Math.round(abs * 10) / 10} pts`;
  if (typeof d.deltaPct !== 'number' || !Number.isFinite(d.deltaPct)) return `${sign}${fmtTileValue({ value: abs, unit: d.unit })}`;
  return `${sign}${Math.round(Math.abs(d.deltaPct) * 10) / 10}%`;
}
export interface RunPreview { report: ReportDefinition; parameters: Record<string, unknown>; period: { from: string; to: string; preset: string; label: string }; result: ReportResult }
export interface ReportRun {
  id: string; scheduleId: string | null; scheduleName: string | null; reportKey: string; customerId: string | null; customerName: string | null; name: string; parameters: Record<string, unknown>; format: string; status: string;
  attachmentId: string | null; filename: string | null; contentType: string | null; size: number | null; rowCount: number | null; error: string | null; deliveredTo: string[]; portalVisible: boolean; requestedBy: string | null; requestedByName: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string;
}
export interface Schedule {
  id: string; name: string; reportKey: string; reportName: string; customerId: string | null; customerName: string | null; recipients: string[]; recipientUserIds: string[]; recipientUsers: { id: string; name: string; email: string }[]; frequency: string; cronExpression: string | null; timezone: string; dateRange: string;
  filters: Record<string, unknown>; format: string; delivery: string; isActive: boolean; lastRunAt: string | null; nextRunAt: string | null; lastRunStatus: string | null; lastRunError?: string | null; createdBy: string | null; createdByName: string | null; createdAt: string;
}
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

export const CATEGORY_LABELS: Record<string, string> = { tickets: 'Tickets', sla: 'Service levels', customers: 'Customers', contracts: 'Contracts', amc: 'AMC & entitlements', assets: 'Assets', cmdb: 'CMDB', field: 'Field service', pm: 'Preventive maintenance', noc: 'NOC', soc: 'SOC', scope: 'Scope & coverage', audit: 'Audit', custom: 'Custom reports' };
export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: 'last_day', label: 'Yesterday' }, { value: 'last_7_days', label: 'Last 7 days' }, { value: 'last_30_days', label: 'Last 30 days' }, { value: 'last_90_days', label: 'Last 90 days' }, { value: 'month_to_date', label: 'Month to date' },
  { value: 'last_month', label: 'Last month' }, { value: 'quarter_to_date', label: 'Quarter to date' }, { value: 'last_quarter', label: 'Last quarter' }, { value: 'year_to_date', label: 'Year to date' }, { value: 'custom', label: 'Custom range' },
];
export const FREQUENCIES = [{ value: 'daily', label: 'Daily (07:00)' }, { value: 'weekly', label: 'Weekly (Monday 07:00)' }, { value: 'monthly', label: 'Monthly (1st, 07:00)' }, { value: 'quarterly', label: 'Quarterly (1st of quarter, 07:00)' }, { value: 'cron', label: 'Custom (cron)' }];

export function formatCell(v: unknown, type?: ReportColumn['type']): string {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'date') return typeof v === 'string' ? v.slice(0, 10) : String(v);
  if (type === 'datetime') { const d = new Date(String(v)); return isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  if (type === 'pct') return typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : String(v);
  if (type === 'minutes') { const m = Math.round(Number(v)); if (isNaN(m)) return String(v); if (Math.abs(m) < 60) return `${m}m`; const h = Math.floor(Math.abs(m) / 60); return `${m < 0 ? '-' : ''}${h < 24 ? `${h}h ${Math.abs(m) % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`}`; }
  if (type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------- the report builder

export type FieldType = 'text' | 'number' | 'minutes' | 'pct' | 'date' | 'datetime' | 'boolean' | 'option' | 'enum' | 'ref';
export type LookupKind = 'customer' | 'site' | 'service' | 'team' | 'user' | 'ciType';
/** One catalogue field (no SQL): how it is typed, whether it may be grouped or aggregated, and how the web resolves filter values. */
export interface CatalogField { key: string; label: string; group: string; type: FieldType; portal: boolean; groupable: boolean; aggregatable: boolean; options?: { optionType?: string; lookup?: LookupKind; values?: { value: string; label: string }[] } }
export interface CatalogEntity { key: string; label: string; description: string; permissions: string[]; permissionsOk: boolean; portal: boolean; dateFields: string[]; defaultDateField: string | null; defaultColumns: string[]; fields: CatalogField[] }
export interface BuilderCatalog { entities: CatalogEntity[]; operators: Record<FieldType, string[]>; operatorLabels: Record<string, string>; presets: string[]; limits: { maxRows: number; previewRows: number }; shareTargets: { roles: { key: string; name: string }[]; teams: { id: string; name: string }[] } }

export interface ReportFilter { field: string; op: string; value?: unknown }
export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface ReportAggregate { fn: AggregateFn; field?: string; label?: string }
export interface ReportSpec { columns: string[]; filters: ReportFilter[]; match: 'all' | 'any'; groupBy: string[]; aggregates: ReportAggregate[]; sort: { key: string; order: 'asc' | 'desc' } | null; dateField: string | null; rowLimit: number | null; chart: { type: 'bar' | 'line'; y: string[] } | null }
export const EMPTY_SPEC: ReportSpec = { columns: [], filters: [], match: 'all', groupBy: [], aggregates: [], sort: null, dateField: null, rowLimit: null, chart: null };
/** The alias the server gives an aggregate column (count, or fn_field); sort keys and chart series name it. */
export const aggregateAlias = (a: ReportAggregate) => (a.fn === 'count' ? 'count' : `${a.fn}_${a.field ?? ''}`);
export const AGGREGATE_LABELS: Record<AggregateFn, string> = { count: 'Count', sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' };

/** What the builder saves (POST /reports/custom) or patches. */
export interface DefinitionInput { name: string; description: string | null; category: string; entity: string; spec: ReportSpec; defaultDateRange: string; scopeCustomerId: string | null; visibility: 'private' | 'shared'; sharedRoleKeys: string[]; sharedTeamIds: string[]; portalVisible: boolean; cover: boolean }
/** A stored custom report as the API returns it (sharing lists and the owner are omitted for portal users). */
export interface CustomReport extends DefinitionInput {
  id: string; key: string; entityLabel: string; scopeCustomerName: string | null; ownerId?: string | null; ownerName: string | null; isActive: boolean; runCount: number; lastRunAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean; summaryLines: string[];
}
export interface PreviewResult extends ReportResult { period: { from: string; to: string; preset: string; label: string }; summaryLines: string[] }
export interface SuggestResult { definition: Partial<DefinitionInput>; ai: boolean; notes: string[] }

/** Plain words for the filter operators (the catalogue payload carries the same map; this is the fallback). */
export const OPERATOR_LABELS: Record<string, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', is_empty: 'is empty', is_not_empty: 'is not empty',
  gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', between: 'is between',
  on: 'is on', before: 'is before', after: 'is after', last_n_days: 'is in the last N days', next_n_days: 'is in the next N days',
  is_true: 'is yes', is_false: 'is no', in: 'is any of', not_in: 'is none of',
};
/** Operators that take no value. */
export const VALUELESS_OPERATORS = ['is_empty', 'is_not_empty', 'is_true', 'is_false'];
export const VISIBILITY_LABELS: Record<string, string> = { private: 'Private', shared: 'Shared', portal: 'Portal' };
/** The sharing badge of a definition: portal when published, else its visibility. */
export const visibilityOf = (d: { visibility: string | null; portalVisible: boolean }) => (d.portalVisible ? 'portal' : d.visibility ?? 'shared');
