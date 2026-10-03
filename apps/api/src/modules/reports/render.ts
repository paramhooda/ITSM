import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { escapeHtml } from '@/lib/templates';
import type { ReportChart, ReportColumn, ReportResult } from './registry';

export const HTML_MAX_ROWS = 2000;
/** Tables with more columns than this print on landscape pages. */
export const WIDE_COLUMNS = 9;

export interface RenderMeta {
  reportName: string;
  description?: string;
  platformName: string;
  customerName?: string | null;
  period: string;
  generatedAt: Date;
  generatedBy?: string | null;
  parameters?: Record<string, unknown>;
  /** `platform.logo_url`: an https URL or a data URI shown on the cover and the header. */
  logoUrl?: string | null;
  /** `platform.brand_color`: hex colour for headers and the cover. */
  brandColor?: string | null;
  /** Render a cover page (review packs and PDF output). */
  cover?: boolean;
}

// ---------------------------------------------------------------- value formatting

const pad = (n: number) => String(n).padStart(2, '0');
export function formatValue(v: unknown, type?: ReportColumn['type']): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') {
    const d = v instanceof Date ? v : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
    return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }
  if (type === 'datetime') {
    const d = v instanceof Date ? v : new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  }
  if (type === 'pct') return typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : String(v);
  if (type === 'minutes') {
    const m = Math.round(Number(v));
    if (isNaN(m)) return String(v);
    if (Math.abs(m) < 60) return `${m}m`;
    const h = Math.floor(Math.abs(m) / 60);
    const rem = Math.abs(m) % 60;
    return `${m < 0 ? '-' : ''}${h < 24 ? `${h}h${rem ? ` ${rem}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`}`;
  }
  if (type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'number' && typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

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
  return Buffer.from(parts.join(''), 'utf8');
}

// ---------------------------------------------------------------- SVG charts (server-side, no external assets)

/** Categorical slots from the validated reference palette (light surface). */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const INK = '#0f172a';
const MUTED = '#64748b';
const GRID = '#e5e7eb';

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
};
const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function svgChart(chart: ReportChart, width = 640, height = 240): string {
  const series = Array.isArray(chart.y) ? chart.y : [chart.y];
  const data = chart.data.slice(0, chart.type === 'bar' ? 40 : 400);
  if (!data.length) return `<div class="chart empty"><div class="chart-title">${escapeHtml(chart.title)}</div><div class="muted">No data</div></div>`;
  const m = { top: 16, right: 16, bottom: 48, left: 44 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((k) => Number(d[k]) || 0))));
  const y = (v: number) => m.top + h - (Math.max(0, v) / max) * h;
  const parts: string[] = [];
  // grid + y ticks
  const ticks = max <= 4 && Number.isInteger(max) ? max : 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}" stroke-width="1"/>`, `<text x="${m.left - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="${MUTED}">${fmtTick(v)}</text>`);
  }
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  if (chart.type === 'bar') {
    const group = w / data.length;
    const gap = 2;
    const barW = Math.min(40, Math.max(2, (group - 8) / series.length - gap));
    const offset = (group - (barW + gap) * series.length) / 2;
    data.forEach((d, i) => {
      series.forEach((k, si) => {
        const v = Number(d[k]) || 0;
        const x = m.left + i * group + offset + si * (barW + gap);
        const top = y(v);
        parts.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, m.top + h - top).toFixed(1)}" rx="2" fill="${SERIES[si % SERIES.length]}"><title>${escapeHtml(`${d[chart.x]}: ${v}`)}</title></rect>`);
      });
      if (i % labelEvery === 0) parts.push(`<text x="${(m.left + i * group + group / 2).toFixed(1)}" y="${height - m.bottom + 14}" font-size="10" text-anchor="end" fill="${MUTED}" transform="rotate(-30 ${(m.left + i * group + group / 2).toFixed(1)} ${height - m.bottom + 14})">${escapeHtml(trunc(String(d[chart.x] ?? ''), 18))}</text>`);
    });
  } else {
    const step = data.length > 1 ? w / (data.length - 1) : 0;
    series.forEach((k, si) => {
      const pts = data.map((d, i) => `${(m.left + i * step).toFixed(1)},${y(Number(d[k]) || 0).toFixed(1)}`);
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${SERIES[si % SERIES.length]}" stroke-width="2" stroke-linejoin="round"/>`);
      if (data.length <= 60) data.forEach((d, i) => parts.push(`<circle cx="${(m.left + i * step).toFixed(1)}" cy="${y(Number(d[k]) || 0).toFixed(1)}" r="3" fill="${SERIES[si % SERIES.length]}" stroke="#fff" stroke-width="1.5"><title>${escapeHtml(`${d[chart.x]}: ${d[k]}`)}</title></circle>`));
    });
    data.forEach((d, i) => {
      if (i % labelEvery === 0 || i === data.length - 1) parts.push(`<text x="${(m.left + i * step).toFixed(1)}" y="${height - m.bottom + 14}" font-size="10" text-anchor="middle" fill="${MUTED}">${escapeHtml(trunc(String(d[chart.x] ?? ''), 12))}</text>`);
    });
  }
  parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${m.top + h}" y2="${m.top + h}" stroke="#cbd5e1" stroke-width="1"/>`);
  const legend = series.length > 1 ? `<div class="legend">${series.map((k, i) => `<span><i style="background:${SERIES[i % SERIES.length]}"></i>${escapeHtml(chart.labels?.[k] ?? k)}</span>`).join('')}</div>` : '';
  return `<div class="chart"><div class="chart-title">${escapeHtml(chart.title)}</div><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(chart.title)}" font-family="Segoe UI, Helvetica, Arial, sans-serif">${parts.join('')}</svg>${legend}</div>`;
}

// ---------------------------------------------------------------- HTML

function tableHtml(columns: ReportColumn[], rows: Record<string, unknown>[], max = HTML_MAX_ROWS) {
  if (!rows.length) return `<div class="muted">No rows</div>`;
  const numeric = (c: ReportColumn) => c.type === 'number' || c.type === 'pct' || c.type === 'minutes';
  const head = columns.map((c) => `<th class="${numeric(c) ? 'num' : ''}">${escapeHtml(c.label)}</th>`).join('');
  const body = rows.slice(0, max).map((r) => `<tr>${columns.map((c) => `<td class="${numeric(c) ? 'num' : ''}">${escapeHtml(formatValue(r[c.key], c.type))}</td>`).join('')}</tr>`).join('');
  const note = rows.length > max ? `<div class="muted">Showing the first ${max} of ${rows.length} rows. Download the CSV for the full list.</div>` : '';
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}`;
}

export function summaryHtml(result: ReportResult): string {
  if (!result.summary?.length) return '';
  return `<table class="summary" cellspacing="0" cellpadding="0"><tr>${result.summary
    .map((s) => `<td style="padding:8px 14px 8px 0;vertical-align:top"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(s.label)}</div><div style="font-size:20px;font-weight:600;color:#0f172a">${escapeHtml(formatValue(s.value, typeof s.value === 'number' ? 'number' : 'text'))}</div>${s.hint ? `<div style="font-size:11px;color:#94a3b8">${escapeHtml(s.hint)}</div>` : ''}</td>`)
    .join('')}</tr></table>`;
}

/** A brand colour from settings, or the default ink when the value is not a hex colour. */
export const brandColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : INK);
/** A logo URL from settings: https or an inline image only (the HTML is opened by Chromium and by mail clients). */
export const logoUrl = (v: unknown) => (typeof v === 'string' && /^(https:\/\/[^\s"'<>]{1,2000}|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]{1,400000})$/.test(v.trim()) ? v.trim() : null);

function coverHtml(result: ReportResult, meta: RenderMeta, logo: string | null): string {
  const contents = ['Summary', ...(result.charts?.length ? ['Charts'] : []), `Detail (${result.rows.length} rows)`, ...(result.sections ?? []).map((s) => `${s.title} (${s.rows.length})`)];
  const generated = meta.generatedAt.toISOString().slice(0, 10);
  return `<div class="cover">
<div class="cover-brand">${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(meta.platformName)}">` : `<span>${escapeHtml(meta.platformName)}</span>`}</div>
<div class="cover-main"><div class="cover-kicker">Service report</div><h1>${escapeHtml(meta.reportName)}</h1>${meta.customerName ? `<div class="cover-customer">${escapeHtml(meta.customerName)}</div>` : ''}<div class="cover-period">${escapeHtml(meta.period)}</div>${meta.description ? `<p class="cover-desc">${escapeHtml(meta.description)}</p>` : ''}</div>
<div class="cover-contents"><div class="cover-contents-title">Contents</div><ol>${contents.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol></div>
<div class="cover-foot">Prepared ${generated}${meta.generatedBy ? ` by ${escapeHtml(meta.generatedBy)}` : ''} · ${escapeHtml(meta.platformName)}</div>
</div>`;
}

export function renderHtml(result: ReportResult, meta: RenderMeta): string {
  const brand = brandColor(meta.brandColor);
  const logo = logoUrl(meta.logoUrl);
  const tiles = (result.summary ?? []).map((s) => `<div class="tile"><div class="label">${escapeHtml(s.label)}</div><div class="value">${escapeHtml(formatValue(s.value, typeof s.value === 'number' ? 'number' : 'text'))}</div>${s.hint ? `<div class="hint">${escapeHtml(s.hint)}</div>` : ''}</div>`).join('');
  const charts = (result.charts ?? []).map((c) => svgChart(c)).join('');
  // tables with many columns go on landscape pages in print (named pages); narrow ones stay portrait
  const block = (title: string, columns: ReportColumn[], rows: Record<string, unknown>[], max: number) => `<div class="${columns.length > WIDE_COLUMNS ? 'wide' : 'narrow'}"><h2>${escapeHtml(title)}</h2>${tableHtml(columns, rows, max)}</div>`;
  const sections = (result.sections ?? []).map((s) => block(s.title, s.columns, s.rows, 500)).join('');
  const params = Object.entries(meta.parameters ?? {})
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['customerId', 'from', 'to', 'dateRange'].includes(k))
    .map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</span>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meta.reportName)} - ${escapeHtml(meta.period)}</title>
<style>
@page{size:A4;margin:12mm 10mm 14mm}@page landscape{size:A4 landscape;margin:12mm 10mm 14mm}
:root{color-scheme:light}body{margin:0;padding:32px;background:#f4f5f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:${INK};font-size:13px;line-height:1.45}
.sheet{max-width:1100px;margin:0 auto;background:#fff;border:1px solid #e4e7eb;border-radius:10px;overflow:hidden}
.head{padding:22px 28px;background:${brand};color:#fff;display:flex;align-items:center;gap:18px}.head .brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75}.head h1{margin:4px 0 2px;font-size:22px;font-weight:600}.head .meta{font-size:13px;opacity:.85}.head img{max-height:40px;max-width:160px;background:#fff;border-radius:6px;padding:4px}
.body{padding:24px 28px}h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid ${brand}}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}.tile{flex:1 1 140px;min-width:140px;background:#f8fafc;border:1px solid #e4e7eb;border-radius:8px;padding:12px 14px}
.tile .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED}}.tile .value{font-size:22px;font-weight:600;margin-top:2px}.tile .hint{font-size:11px;color:#94a3b8}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:12px}.chart{border:1px solid #e4e7eb;border-radius:8px;padding:12px}.chart-title{font-weight:600;font-size:13px;margin-bottom:6px}.chart.empty .muted{padding:24px 0;text-align:center}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:${MUTED};margin-top:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:${MUTED};background:#f8fafc;padding:7px 8px;border-bottom:1px solid #e4e7eb;white-space:nowrap}td{padding:6px 8px;border-bottom:1px solid #eef0f3;vertical-align:top}tr:nth-child(even) td{background:#fbfcfd}.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:${MUTED};font-size:12px;margin:8px 0}.pill{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:2px 8px;font-size:11px;margin:0 6px 6px 0}
.foot{padding:12px 28px;background:#f8fafc;color:${MUTED};font-size:11px;border-top:1px solid #e4e7eb}
.cover{display:flex;flex-direction:column;box-sizing:border-box;min-height:560px;padding:40px 48px;overflow:hidden;background:linear-gradient(160deg,${brand} 0%,${brand} 55%,#1e293b 100%);color:#fff}
.cover-brand{font-size:14px;letter-spacing:.1em;text-transform:uppercase;opacity:.85}.cover-brand img{max-height:56px;max-width:220px;background:#fff;border-radius:8px;padding:6px}
.cover-main{margin:64px 0 40px}.cover-kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7}.cover h1{font-size:34px;font-weight:700;margin:6px 0 10px;line-height:1.15}.cover-customer{font-size:20px;font-weight:500}.cover-period{font-size:15px;opacity:.85;margin-top:4px}.cover-desc{max-width:620px;font-size:13px;opacity:.8;line-height:1.5}
.cover-contents{margin-top:auto;border-top:1px solid rgba(255,255,255,.3);padding-top:14px}.cover-contents-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:6px}.cover-contents ol{margin:0;padding-left:18px;columns:2;font-size:12.5px;line-height:1.7}
.cover-foot{margin-top:18px;font-size:11px;opacity:.7}
@media print{body{padding:0;background:#fff}.sheet{border:0;max-width:none;border-radius:0;overflow:visible}table{table-layout:auto}th{white-space:normal;overflow-wrap:normal;word-break:normal;padding:5px 6px}td{overflow-wrap:anywhere;word-break:break-word;font-size:11px;padding:4px 6px}.wide{page:landscape}.wide h2{margin-top:0}.wide td{font-size:10px;padding:3px 5px}.wide th{font-size:10px;padding:4px 5px}.chart{break-inside:avoid}tr{break-inside:avoid}h2{break-after:avoid}.head,.cover,.tile,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}.cover{height:calc(297mm - 27mm);min-height:0;padding:36px 44px;break-after:page;page-break-after:always}.cover-main{margin:48px 0 24px}}
</style></head><body><div class="sheet">
${meta.cover ? coverHtml(result, meta, logo) : ''}
<div class="head">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}<div><div class="brand">${escapeHtml(meta.platformName)}</div><h1>${escapeHtml(meta.reportName)}</h1><div class="meta">${meta.customerName ? `${escapeHtml(meta.customerName)} · ` : ''}${escapeHtml(meta.period)}</div></div></div>
<div class="body">
${meta.description ? `<div class="muted" style="margin-top:0">${escapeHtml(meta.description)}</div>` : ''}${params ? `<div>${params}</div>` : ''}
${tiles ? `<div class="tiles">${tiles}</div>` : ''}
${charts ? `<div class="charts">${charts}</div>` : ''}
${block(`Detail (${result.rows.length} rows)`, result.columns, result.rows, HTML_MAX_ROWS)}
${sections}
</div>
<div class="foot">Generated ${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC${meta.generatedBy ? ` by ${escapeHtml(meta.generatedBy)}` : ''} · ${escapeHtml(meta.platformName)}</div>
</div></body></html>`;
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
  if (result.summary?.length) {
    section('Summary');
    for (const s of result.summary) {
      const row = summary.addRow([s.label, typeof s.value === 'number' ? s.value : s.value ?? '', s.hint ?? '']);
      row.getCell(2).alignment = { horizontal: 'left' };
    }
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
    for (const chart of result.charts) {
      const series = Array.isArray(chart.y) ? chart.y : [chart.y];
      ws.addRow([chart.title]).font = { bold: true };
      ws.addRow([chart.x, ...series.map((k) => chart.labels?.[k] ?? k)]).font = { bold: true, color: { argb: 'FF64748B' } };
      for (const d of chart.data.slice(0, 1000)) ws.addRow([String(d[chart.x] ?? ''), ...series.map((k) => (Number.isFinite(Number(d[k])) ? Number(d[k]) : String(d[k] ?? '')))]);
      ws.addRow([]);
    }
    sheets.push({ name: ws.name, rows: result.charts.length });
  }
  for (const s of sheets) summary.addRow([s.name, s.rows, '']).getCell(2).numFmt = '#,##0';
  if (result.truncated) summary.addRow(['The detail table was cut at the row limit; narrow the period or the filters for the full list.']).font = { italic: true, color: { argb: 'FFB45309' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
