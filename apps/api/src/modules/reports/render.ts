import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { escapeHtml } from '@/lib/templates';
import type { ReportChart, ReportColumn, ReportResult } from './registry';
import { renderChart, type ChartOpts } from './theme/charts';
import { renderDocument, type RenderMeta } from './theme/document';
import { brandColor, formatValue, HTML_MAX_ROWS, logoUrl, WIDE_COLUMNS } from './theme/format';
import { fmtTileValue } from './insights';
import { DOC } from './theme/tokens';

export { HTML_MAX_ROWS, WIDE_COLUMNS, formatValue, brandColor, logoUrl, accentColor } from './theme/format';
export type { RenderMeta } from './theme/document';

// ---------------------------------------------------------------- CSV

export function renderCsv(result: ReportResult): Buffer {
  const columns = result.columns.map((c) => ({ key: c.key, header: c.label }));
  const rows = result.rows.map((r) => Object.fromEntries(result.columns.map((c) => [c.key, formatValue(r[c.key], c.type)])));
  const parts: string[] = [stringify(rows, { header: true, columns })];
  for (const s of result.sections ?? []) {
    if (!s.rows.length) continue;
    const cols = s.columns.map((c) => ({ key: c.key, header: c.label }));
    parts.push(`\n${s.title}\n`, stringify(s.rows.map((r) => Object.fromEntries(s.columns.map((c) => [c.key, formatValue(r[c.key], c.type)]))), { header: true, columns: cols }));
  }
  const insights = [...(result.narrative?.wentWell ?? []).map((t) => ({ kind: 'good', text: t })), ...(result.narrative?.needsAttention ?? []).map((t) => ({ kind: 'attention', text: t })), ...(result.narrative?.nextSteps ?? []).map((t) => ({ kind: 'next step', text: t }))];
  if (insights.length) parts.push(`\nInsights\n`, stringify(insights, { header: true, columns: [{ key: 'kind', header: 'kind' }, { key: 'text', header: 'text' }] }));
  return Buffer.from(parts.join(''), 'utf8');
}

// ---------------------------------------------------------------- SVG charts (server-side, no external assets)

/** Compatibility wrapper around the theme's chart renderer (width and height in pixels). */
export function svgChart(chart: ReportChart, width?: number, height?: number): string {
  const opts: ChartOpts = {};
  if (width !== undefined) opts.width = width;
  if (height !== undefined) opts.height = height;
  return renderChart(chart, opts);
}

// ---------------------------------------------------------------- HTML

/** The summary block of the delivery email: the narrative sentence, then the tiles. */
export function summaryHtml(result: ReportResult): string {
  const lede = result.narrative?.summary ? `<p style="margin:0 0 10px;font-size:14px;color:${DOC.ink2}">${escapeHtml(result.narrative.summary)}</p>` : '';
  if (!result.summary?.length) return lede;
  return `${lede}<table class="summary" cellspacing="0" cellpadding="0"><tr>${result.summary
    .slice(0, 8)
    .map((s) => `<td style="padding:8px 14px 8px 0;vertical-align:top"><div style="font-size:11px;color:${DOC.muted};text-transform:uppercase;letter-spacing:.04em">${escapeHtml(s.label)}</div><div style="font-size:20px;font-weight:600;color:${DOC.ink}">${escapeHtml(fmtTileValue(s))}</div>${s.hint ? `<div style="font-size:11px;color:${DOC.subtle}">${escapeHtml(s.hint)}</div>` : ''}</td>`)
    .join('')}</tr></table>`;
}

/** The report document (see theme/document.ts); `meta.cover` prints the cover page. */
export function renderHtml(result: ReportResult, meta: RenderMeta): string {
  return renderDocument({ result, meta });
}

// ---------------------------------------------------------------- Excel (exceljs)

export const XLSX_MAX_ROWS = 100_000;
const NUM_FMT: Partial<Record<NonNullable<ReportColumn['type']>, string>> = { date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm', pct: '0.0"%"', number: '#,##0.##', minutes: '#,##0' };
const SHEET_FORBIDDEN = /[\\/?*[\]:]/g;

/** Typed cell values so Excel sorts and sums them: numbers stay numbers, dates become dates. */
function cellValue(v: unknown, type?: ReportColumn['type']): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date' || type === 'datetime') {
    const d = v instanceof Date ? v : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
    return isNaN(d.getTime()) ? String(v) : d;
  }
  if (type === 'number' || type === 'pct' || type === 'minutes') {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  if (type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Excel limits sheet names to 31 characters without `\ / ? * [ ] :`, unique per workbook. */
function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(SHEET_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 25)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

function addTable(wb: ExcelJS.Workbook, name: string, columns: ReportColumn[], rows: Record<string, unknown>[], brand: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.type === 'minutes' ? `${c.label} (min)` : c.label, key: c.key, width: Math.min(60, Math.max(10, c.label.length + 4)), style: c.type && NUM_FMT[c.type] ? { numFmt: NUM_FMT[c.type] } : {} }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(brand) } };
  head.alignment = { vertical: 'middle' };
  for (const r of rows.slice(0, XLSX_MAX_ROWS)) ws.addRow(columns.map((c) => cellValue(r[c.key], c.type)));
  columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    let width = column.width ?? 10;
    for (const r of rows.slice(0, 300)) width = Math.max(width, Math.min(60, formatValue(r[c.key], c.type).length + 2));
    column.width = width;
  });
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/**
 * Workbook: a Summary sheet (report, customer, period, the summary figures, the
 * parameters and a contents list), the detail table, one sheet per section and
 * the chart data, every column typed.
 */
export async function renderXlsx(result: ReportResult, meta: RenderMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.platformName;
  wb.created = meta.generatedAt;
  wb.title = `${meta.reportName} - ${meta.period}`;
  const brand = brandColor(meta.brandColor);
  const used = new Set<string>();
  const summary = wb.addWorksheet(sheetName('Summary', used));
  summary.columns = [{ key: 'a', width: 34 }, { key: 'b', width: 28 }, { key: 'c', width: 48 }];
  summary.addRow([meta.reportName]).font = { bold: true, size: 16, color: { argb: argb(brand) } };
  summary.addRow([[meta.customerName, meta.period].filter(Boolean).join(' · ')]).font = { size: 12 };
  if (meta.description) summary.addRow([meta.description]).font = { italic: true, color: { argb: 'FF64748B' } };
  summary.addRow([`Generated ${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''} · ${meta.platformName}`]).font = { color: { argb: 'FF64748B' } };
  summary.addRow([]);
  const section = (title: string) => {
    const row = summary.addRow([title]);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(brand) } };
  };
  if (result.narrative?.summary) {
    summary.addRow([result.narrative.summary]).font = { italic: true };
    summary.addRow([]);
  }
  if (result.summary?.length) {
    section('Summary');
    for (const s of result.summary) {
      const previous = s.delta && typeof s.delta.previous === 'number' ? `previous ${fmtTileValue({ value: s.delta.previous, unit: s.unit })}${s.delta.change !== null && s.delta.change !== undefined ? ` (${s.delta.change > 0 ? '+' : ''}${s.delta.change})` : ''}` : '';
      const row = summary.addRow([s.label, typeof s.value === 'number' ? s.value : s.value ?? '', [s.hint, previous].filter(Boolean).join(' · ')]);
      row.getCell(2).alignment = { horizontal: 'left' };
    }
    summary.addRow([]);
  }
  const insightRows = [...(result.narrative?.wentWell ?? []).map((t) => ['Went well', t]), ...(result.narrative?.needsAttention ?? []).map((t) => ['Needs attention', t]), ...(result.narrative?.nextSteps ?? []).map((t) => ['Next step', t])];
  if (insightRows.length) {
    section('Insights');
    for (const r of insightRows) summary.addRow(r);
    summary.addRow([]);
  }
  if (result.recommendations?.length) {
    section('Recommendations');
    for (const r of result.recommendations) summary.addRow([r.area, r.recommendation, r.evidence]);
    summary.addRow([]);
  }
  const params = Object.entries(meta.parameters ?? {}).filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['customerId', 'from', 'to', 'dateRange'].includes(k));
  if (params.length) {
    section('Parameters');
    for (const [k, v] of params) summary.addRow([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    summary.addRow([]);
  }
  section('Contents');
  const sheets: { name: string; rows: number }[] = [];
  const detail = addTable(wb, sheetName('Detail', used), result.columns, result.rows, brand);
  sheets.push({ name: detail.name, rows: result.rows.length });
  for (const s of result.sections ?? []) {
    const ws = addTable(wb, sheetName(s.title, used), s.columns, s.rows, brand);
    sheets.push({ name: ws.name, rows: s.rows.length });
  }
  if (result.charts?.length) {
    const ws = wb.addWorksheet(sheetName('Charts', used));
    ws.columns = [{ width: 36 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
    const allCharts = [...result.charts, ...(result.sections ?? []).flatMap((s) => s.charts ?? [])];
    for (const chart of allCharts) {
      const series = Array.isArray(chart.y) ? chart.y : [chart.y];
      ws.addRow([chart.title]).font = { bold: true };
      if (chart.type === 'heatmap') {
        // the grid as triples so a pivot table can rebuild it
        ws.addRow(['row', 'col', 'value']).font = { bold: true, color: { argb: 'FF64748B' } };
        for (const d of chart.data.slice(0, 2000)) ws.addRow([String(d.row ?? ''), String(d.col ?? ''), Number.isFinite(Number(d[series[0]!])) ? Number(d[series[0]!]) : String(d[series[0]!] ?? '')]);
      } else {
        ws.addRow([chart.x, ...series.map((k) => chart.labels?.[k] ?? k)]).font = { bold: true, color: { argb: 'FF64748B' } };
        for (const d of chart.data.slice(0, 1000)) ws.addRow([String(d[chart.x] ?? ''), ...series.map((k) => (Number.isFinite(Number(d[k])) ? Number(d[k]) : String(d[k] ?? '')))]);
      }
      ws.addRow([]);
    }
    sheets.push({ name: ws.name, rows: allCharts.length });
  }
  for (const s of sheets) summary.addRow([s.name, s.rows, '']).getCell(2).numFmt = '#,##0';
  if (result.truncated) summary.addRow(['The detail table was cut at the row limit; narrow the period or the filters for the full list.']).font = { italic: true, color: { argb: 'FFB45309' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
