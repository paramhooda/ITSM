export type ParameterType = 'customer' | 'daterange' | 'select' | 'multiselect' | 'boolean' | 'text' | 'number';
export interface ReportParameter { key: string; label: string; type: ParameterType; options?: { value: string; label: string }[]; optionType?: string; required?: boolean; default?: unknown; help?: string }
export interface ReportDefinition { key: string; name: string; description: string; category: string; permissions: string[]; portal: boolean; parameters: ReportParameter[]; defaultDateRange: string }
export interface ReportColumn { key: string; label: string; type?: 'date' | 'datetime' | 'number' | 'pct' | 'minutes' | 'text' | 'boolean' }
export interface ReportChart { type: 'bar' | 'line'; title: string; data: Record<string, unknown>[]; x: string; y: string | string[]; labels?: Record<string, string> }
export interface ReportSection { title: string; columns: ReportColumn[]; rows: Record<string, unknown>[] }
export interface ReportResult { columns: ReportColumn[]; rows: Record<string, unknown>[]; summary?: { label: string; value: string | number | null; hint?: string }[]; charts?: ReportChart[]; sections?: ReportSection[]; truncated?: boolean; rowCount: number }
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

export const CATEGORY_LABELS: Record<string, string> = { tickets: 'Tickets', sla: 'Service levels', customers: 'Customers', contracts: 'Contracts', amc: 'AMC & entitlements', assets: 'Assets', cmdb: 'CMDB', field: 'Field service', pm: 'Preventive maintenance', noc: 'NOC', soc: 'SOC', scope: 'Scope & coverage', audit: 'Audit' };
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
