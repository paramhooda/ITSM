import { escapeHtml } from '@/lib/templates';
import type { Insight, ReportChart, ReportColumn, ReportResult, ReportSection, SummaryTile } from '../registry';
import { DEFAULT_GLOSSARY, fmtDelta, fmtTileValue } from '../insights';
import { GEIST_WOFF2_DATA_URI, LOGO_PNG_DATA_URI } from './assets';
import { renderChart, sparkline } from './charts';
import { accentColor, brandColor, formatValue, HTML_MAX_ROWS, isNumericColumn, logoUrl, WIDE_COLUMNS } from './format';
import { CATEGORICAL, DELTA_TEXT, DOC, STATUS, TYPE } from './tokens';

/**
 * The report document: one self-contained HTML file printed by Chromium to A4
 * and opened as-is by browsers and mail clients. Light theme, the brand navy
 * for headings and the accent for the cover stripe and section markers, the
 * embedded wordmark and typeface, a cover, a running header and footer with
 * page numbers through @page margin boxes, an executive summary with KPI
 * tiles and the three lists, grouped sections with charts, callouts and
 * zebra tables, and an appendix of definitions and data notes.
 */

export const DOCUMENT_VERSION = 'docs-2';

export interface RenderMeta {
  reportName: string;
  description?: string;
  platformName: string;
  customerName?: string | null;
  customerCode?: string | null;
  accountManager?: string | null;
  period: string;
  generatedAt: Date;
  generatedBy?: string | null;
  parameters?: Record<string, unknown>;
  /** `platform.logo_url`: an https URL or a data URI; empty uses the bundled wordmark. */
  logoUrl?: string | null;
  /** `platform.brand_color`: headings, the cover title, section rules. */
  brandColor?: string | null;
  /** `platform.brand_accent`: the cover stripe and section markers. */
  brandAccent?: string | null;
  /** Render a cover page (review packs and PDF output). */
  cover?: boolean;
  /** Footer line on every page; defaults to "<platform> internal. Confidential: not for onward distribution." */
  confidentiality?: string;
  comparisonLabel?: string | null;
  timezone?: string;
  kind?: 'report' | 'pack';
  /** Rows printed per table in pack documents. */
  printRows?: number;
  portal?: boolean;
  /** Staff without soc:read: the document says SOC tickets are excluded. */
  socExcluded?: boolean;
  reportKey?: string;
  runId?: string | null;
}

export interface DocumentInput {
  result: ReportResult;
  meta: RenderMeta;
}

const esc = (v: unknown) => escapeHtml(v === null || v === undefined ? '' : String(v));

/** Longest string printed in a running header or footer; Chromium wraps a margin box onto further lines inside the page margin, so this only bounds the wrapping. */
export const CSS_STRING_MAX = 140;

/**
 * A string for an @page `content:` declaration: newlines collapsed, cut at a word
 * boundary with an ellipsis beyond CSS_STRING_MAX, and quotes, backslashes and
 * angle brackets escaped the CSS way, so a name can never end the style block
 * or start markup inside the HTML file.
 */
export function cssString(s: string): string {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  const cut = flat.length > CSS_STRING_MAX ? `${flat.slice(0, CSS_STRING_MAX - 1).replace(/\s+\S*$/, '')}…` : flat;
  return cut.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/>/g, '\\3e ');
}

export function sectionId(title: string): string {
  return `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'}`;
}

const glyph = (color: string) => `<svg class="glyph" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="${color}"/></svg>`;
const KIND_COLOR: Record<Insight['kind'], string> = { good: STATUS.good, attention: STATUS.warning, info: CATEGORICAL[0] };
const arrow = (up: boolean, color: string) => `<svg class="arrow" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="${up ? 'M4 1 L7.5 7 L0.5 7 Z' : 'M4 7 L7.5 1 L0.5 1 Z'}" fill="${color}"/></svg>`;

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;

// ---------------------------------------------------------------- tiles

/** "4.5 d" for 6,447 minutes, "1.8 h" for 107: the readable twin of a long duration. */
function humanMinutes(v: number): string | null {
  if (!Number.isFinite(v) || v < 120) return null;
  if (v < 48 * 60) return `${Math.round((v / 60) * 10) / 10} h`;
  return `${Math.round((v / 1440) * 10) / 10} d`;
}

/** The tile value: the unit is left off when the label already names it ("MTTR (min)", "Age (h)", "On-time %"). */
function tileValue(t: SummaryTile): string {
  if (typeof t.value === 'number' && /\((min|h|%)\)$/.test(t.label)) return fmtTileValue({ value: t.value, unit: 'count' });
  return fmtTileValue(t);
}

function tileHtml(t: SummaryTile, comparison: string | null | undefined, compact = false): string {
  const d = t.delta;
  const improved = d && typeof d.change === 'number' && !d.neutral ? (d.change === 0 ? null : d.lowerIsBetter ? d.change < 0 : d.change > 0) : null;
  const deltaColor = improved === null ? DELTA_TEXT.neutral : improved ? DELTA_TEXT.good : DELTA_TEXT.bad;
  const delta = d && typeof d.change === 'number' && typeof d.previous === 'number' ? `<div class="delta" style="color:${deltaColor}">${d.change === 0 ? '' : arrow(d.change > 0, deltaColor)}${esc(fmtDelta({ ...d, unit: d.unit ?? t.unit }))}<span class="vs">vs ${esc(comparison ?? 'previous period')}</span></div>` : '';
  const tone = t.tone ?? (typeof t.target === 'number' && typeof t.value === 'number' ? (d?.lowerIsBetter ? (t.value <= t.target ? 'good' : 'bad') : t.value >= t.target ? 'good' : t.value >= t.target - 5 ? 'warn' : 'bad') : undefined);
  const spark = !compact && t.spark && t.spark.length > 1 ? sparkline(t.spark) : '';
  const target = typeof t.target === 'number' ? `<span class="target">target ${esc(fmtTileValue({ value: t.target, unit: t.unit }))}</span>` : '';
  const twin = t.unit === 'minutes' && typeof t.value === 'number' ? humanMinutes(t.value) : null;
  const hint = [twin ? `about ${twin}` : '', t.hint ?? ''].filter(Boolean).join(' · ');
  return `<div class="tile${tone ? ` ${tone}` : ''}${compact ? ' compact' : ''}"><div class="label">${esc(t.label)}</div><div class="row"><div class="value">${esc(tileValue(t))}</div>${spark}</div>${delta}${hint || target ? `<div class="hint">${esc(hint)}${hint && target ? ' · ' : ''}${target}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------- tables

interface TableOut {
  html: string;
  cut: boolean;
  /** More columns than fit a portrait page (and enough rows to be worth a landscape page). */
  wide: boolean;
}

/** Rows printed per table in a plain document; the Excel workbook and the CSV hold every row. */
export const DOC_MAX_ROWS = 100;

/** Record numbers and tags (INC-001258, AST-000002, CTR-2026-0002): printed on one line. */
const IDENTIFIER = /^[A-Z]{2,6}-\d[\d-]{0,14}$/;

function totalsRow(columns: ReportColumn[], rows: Record<string, unknown>[]): string {
  const totals = columns.filter((c) => c.total);
  if (!totals.length || !rows.length) return '';
  const labelIndex = columns.findIndex((c) => !c.total);
  const allAvg = totals.every((c) => c.total === 'avg');
  const cells = columns.map((c, i) => {
    if (c.total) {
      const nums = rows.map((r) => Number(r[c.key])).filter((n) => Number.isFinite(n));
      if (!nums.length) return `<td class="num"></td>`;
      const sum = nums.reduce((s, n) => s + n, 0);
      const v = c.total === 'sum' ? sum : Math.round((sum / nums.length) * 10) / 10;
      return `<td class="num">${esc(formatValue(v, c.type === 'date' || c.type === 'datetime' || c.type === 'text' || c.type === 'boolean' ? 'number' : c.type ?? 'number'))}</td>`;
    }
    return `<td class="${isNumericColumn(c) ? 'num' : ''}">${i === labelIndex ? (allAvg ? 'Average' : 'Total') : ''}</td>`;
  });
  return `<tfoot><tr>${cells.join('')}</tr></tfoot>`;
}

function tableHtml(columns: ReportColumn[], rows: Record<string, unknown>[], limit: number, totals: boolean): TableOut {
  if (!rows.length) return { html: `<p class="muted">No rows</p>`, cut: false, wide: false };
  const head = columns.map((c) => `<th class="${isNumericColumn(c) ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const printed = rows.slice(0, limit);
  // a date never wraps, a date-time breaks once at most (between the date and the time) and an identifier such as INC-001258 or CTR-2026-0002 never splits at its hyphen
  const cell = (c: ReportColumn, v: unknown) => {
    const text = formatValue(v, c.type);
    if (typeof v === 'string' && IDENTIFIER.test(v)) return `<span class="nw">${esc(text)}</span>`;
    if (c.type === 'date') return `<span class="nw">${esc(text)}</span>`;
    if (c.type === 'datetime') {
      const at = text.indexOf(' ');
      return at > 0 ? `<span class="nw">${esc(text.slice(0, at))}</span> <span class="nw">${esc(text.slice(at + 1))}</span>` : esc(text);
    }
    return esc(text);
  };
  const body = printed.map((r) => `<tr>${columns.map((c) => `<td class="${isNumericColumn(c) ? 'num' : ''}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('');
  const cut = rows.length > limit;
  const note = cut ? `<p class="muted note">Showing the first ${limit} of ${rows.length} rows; the full list is in the Excel workbook and the CSV.</p>` : '';
  // a short wide table stays portrait in small type; a long one gets landscape pages
  const wide = columns.length > WIDE_COLUMNS && printed.length > 4;
  return { html: `<div class="${wide ? 'wide' : columns.length > WIDE_COLUMNS ? 'dense' : 'narrow'}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${totals ? totalsRow(columns, rows) : ''}</table>${note}</div>`, cut, wide };
}

const calloutsHtml = (items: Insight[] | undefined) => (items?.length ? `<ul class="callouts">${items.map((i) => `<li class="${i.kind}">${glyph(KIND_COLOR[i.kind])}<span>${esc(i.text)}${i.evidence ? ` <em>${esc(i.evidence)}</em>` : ''}</span></li>`).join('')}</ul>` : '');
const chartsHtml = (charts: ReportChart[] | undefined) => (charts?.length ? `<div class="charts">${charts.map((c) => renderChart(c)).join('')}</div>` : '');

// ---------------------------------------------------------------- the document

interface Chapter {
  group: string | null;
  sections: ReportSection[];
}

const isEmptySection = (s: ReportSection) => !s.rows.length && !s.charts?.length && !s.callouts?.length;

/** Consecutive sections sharing a group form one chapter; sections without a group stand alone. */
function chapters(sections: ReportSection[]): Chapter[] {
  const out: Chapter[] = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (s.group && last && last.group === s.group) last.sections.push(s);
    else out.push({ group: s.group ?? null, sections: [s] });
  }
  return out;
}

export function renderDocument({ result, meta }: DocumentInput): string {
  const navy = brandColor(meta.brandColor);
  const accent = accentColor(meta.brandAccent);
  const custom = logoUrl(meta.logoUrl);
  const logoSrc = custom ? esc(custom) : LOGO_PNG_DATA_URI;
  const kind = meta.kind ?? 'report';
  const pack = kind === 'pack';
  const printRows = Math.max(10, Math.min(500, meta.printRows ?? 50));
  const confidentiality = meta.confidentiality ?? `${meta.platformName} internal. Confidential: not for onward distribution.`;
  const customerLine = meta.customerName ? `${meta.customerName}${meta.customerCode ? ` · ${meta.customerCode}` : ''}` : '';
  const generated = stamp(meta.generatedAt);
  const narrative = result.narrative;
  const tiles = result.summary ?? [];
  const headlineTiles = tiles.slice(0, 6);
  const moreTiles = tiles.slice(6);

  // ---- sections and chapters
  const sections = result.sections ?? [];
  const printable = sections.filter((s) => !isEmptySection(s));
  const empties = sections.filter(isEmptySection).map((s) => s.title);
  const detailTitle = pack ? 'Scorecard' : 'Detail';
  const detailLimit = pack ? printRows : Math.min(HTML_MAX_ROWS, DOC_MAX_ROWS);
  // a document for one customer never repeats that customer in a column
  const visible = (cols: ReportColumn[]) => (meta.customerName ? cols.filter((c) => c.key !== 'customer') : cols);
  let anyCut = false;
  const chapterList = chapters(printable);
  const contents = [...(pack || tiles.length || narrative ? ['Executive summary'] : []), ...(result.charts && result.charts.length > 2 ? ['Charts'] : []), detailTitle, ...chapterList.map((c) => c.group ?? c.sections[0]!.title), 'Appendix'];

  const sectionBlock = (s: ReportSection, level: 2 | 3) => {
    const limit = s.printLimit ?? (pack ? printRows : DOC_MAX_ROWS);
    const table = s.rows.length ? tableHtml(visible(s.columns), s.rows, limit, s.totals === true) : { html: '', cut: false, wide: false };
    anyCut = anyCut || table.cut;
    const heading = level === 2 ? `<h2 id="${sectionId(s.title)}">${esc(s.title)}</h2>` : `<h3 id="${sectionId(s.title)}">${esc(s.title)}</h3>`;
    // the heading stays with what follows it (never an orphan heading at the foot of a page); a lead with a single row of charts travels as one block, a taller one may break between its chart rows so the previous page is not left half empty; a wide table takes the whole section to a landscape page
    const keep = (s.charts?.length ?? 0) <= 2;
    return `<section class="block${table.wide ? ' wide' : ''}"><div class="lead${keep ? ' keep' : ''}">${heading}${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ''}${chartsHtml(s.charts)}${calloutsHtml(s.callouts)}</div>${table.html}</section>`;
  };
  const chaptersHtml = chapterList.map((c) => (c.group ? `<section class="chapter"><h2 id="${sectionId(c.group)}">${esc(c.group)}</h2>${c.sections.map((s) => sectionBlock(s, 3)).join('')}</section>` : sectionBlock(c.sections[0]!, 2))).join('');

  const detail = tableHtml(visible(result.columns), result.rows, detailLimit, result.columns.some((c) => c.total));
  anyCut = anyCut || detail.cut;
  const rowCount = result.rowCount ?? result.rows.length;

  // ---- cover
  const contentsList = `<ol>${contents.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>`;
  const cover = meta.cover
    ? `<section class="cover">
<div class="cover-brand"><img src="${logoSrc}" alt="${esc(meta.platformName)}"></div>
<div class="cover-main"><div class="kicker">${pack ? 'Service review' : 'Service report'}</div><h1>${esc(meta.reportName)}</h1>${customerLine ? `<div class="cover-customer">${esc(customerLine)}</div>` : ''}<div class="cover-period">${esc(meta.period)}${meta.comparisonLabel ? ` · compared with ${esc(meta.comparisonLabel)}` : ''}</div>${meta.description ? `<p class="cover-desc">${esc(meta.description)}</p>` : ''}</div>
<div class="cover-contents"><div class="caption">Contents</div>${contentsList}</div>
<div class="cover-conf">${esc(confidentiality)}</div>
<div class="cover-foot">Prepared ${generated.slice(0, 10)}${meta.generatedBy ? ` by ${esc(meta.generatedBy)}` : ''} · ${esc(meta.platformName)}</div>
</section>`
    : '';

  // ---- executive summary
  const headlineCharts = (result.charts ?? []).slice(0, 2);
  const restCharts = (result.charts ?? []).slice(2);
  const list = (items: string[], empty: string, ordered = false, color: string = CATEGORICAL[0]) => (items.length ? `<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${ordered ? '' : glyph(color)}<span>${esc(t)}</span></li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : `<p class="muted">${empty}</p>`);
  const exec = `<section class="exec${meta.cover ? ' after-cover' : ''}">
<div class="mast"><img src="${logoSrc}" alt="${esc(meta.platformName)}"><div class="mast-right"><div class="mast-title">${esc(meta.reportName)}</div>${customerLine ? `<div>${esc(customerLine)}</div>` : ''}<div class="muted">${esc(meta.period)}${meta.comparisonLabel ? ` · compared with ${esc(meta.comparisonLabel)}` : ''}</div></div></div>
<h2 id="executive-summary">Executive summary</h2>
${narrative?.summary ? `<p class="lede">${esc(narrative.summary)}</p>` : meta.description ? `<p class="lede">${esc(meta.description)}</p>` : ''}
${headlineTiles.length ? `<div class="tiles">${headlineTiles.map((t) => tileHtml(t, meta.comparisonLabel)).join('')}</div>` : ''}
${narrative ? `<div class="narrative"><div class="col"><h3>${glyph(STATUS.good)}What went well</h3>${list(narrative.wentWell, 'Nothing to flag this period', false, STATUS.good)}</div><div class="col"><h3>${glyph(STATUS.warning)}What needs attention</h3>${list(narrative.needsAttention, 'Nothing to flag this period', false, STATUS.warning)}</div><div class="col"><h3>${glyph(CATEGORICAL[0])}Next steps</h3>${list(narrative.nextSteps, 'No next steps beyond the standing review', true)}</div></div>` : ''}
${moreTiles.length ? `<div class="tiles more">${moreTiles.map((t) => tileHtml(t, meta.comparisonLabel, true)).join('')}</div>` : ''}
${headlineCharts.length ? `<div class="charts headline">${headlineCharts.map((c) => renderChart(c)).join('')}</div>` : ''}
</section>`;

  // ---- appendix
  const glossaryMap = new Map<string, string>();
  for (const g of [...DEFAULT_GLOSSARY, ...(result.glossary ?? [])]) if (!glossaryMap.has(g.term.toLowerCase())) glossaryMap.set(g.term.toLowerCase(), `<div><dt>${esc(g.term)}</dt><dd>${esc(g.meaning)}</dd></div>`);
  const notes: string[] = [`Period: ${meta.period}${meta.comparisonLabel ? `; compared with ${meta.comparisonLabel}` : ''}`];
  if (meta.timezone) notes.push(`Hour-of-day figures use the ${meta.timezone} timezone; timestamps in tables are UTC`);
  if (anyCut) notes.push(`Rows are capped at ${pack ? printRows : DOC_MAX_ROWS} per table in this document; the Excel workbook holds every row`);
  if (result.truncated) notes.push('The detail table was cut at the row limit; narrow the period or the filters for the full list');
  if (meta.socExcluded) notes.push('SOC tickets are excluded for users without soc:read');
  if (empties.length) notes.push(`Sections with nothing to report: ${empties.join(', ')}`);
  for (const n of result.notes ?? []) notes.push(n);
  notes.push('Figures are computed live at generation; dashboards show rolled-up history');
  const params = Object.entries(meta.parameters ?? {})
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['customerId', 'from', 'to', 'dateRange'].includes(k))
    .map(([k, v]) => `<span class="pill">${esc(k)}: ${esc(Array.isArray(v) ? v.join(', ') : String(v))}</span>`)
    .join('');
  const appendix = `<section class="appendix"><h2 id="appendix">Appendix</h2>
<h3>Definitions</h3><dl class="defs">${[...glossaryMap.values()].join('')}</dl>
<h3>Data notes</h3><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
${params ? `<h3>Parameters</h3><div class="pills">${params}</div>` : ''}
<h3>About this document</h3><dl class="about">${meta.reportKey ? `<div><dt>Report</dt><dd>${esc(meta.reportKey)}</dd></div>` : ''}${meta.runId ? `<div><dt>Run</dt><dd>${esc(meta.runId)}</dd></div>` : ''}<div><dt>Generated</dt><dd>${generated}${meta.generatedBy ? ` by ${esc(meta.generatedBy)}` : ''}</dd></div><div><dt>Platform</dt><dd>${esc(meta.platformName)}</dd></div><div><dt>Confidentiality</dt><dd>${esc(confidentiality)}</dd></div><div><dt>Document</dt><dd>${DOCUMENT_VERSION}</dd></div></dl>
</section>`;

  // ---- @page strings
  const header = cssString(`${meta.reportName}${meta.customerName ? ` · ${meta.customerName}` : ''}`);
  const periodStr = cssString(meta.period);
  const footLeft = cssString(confidentiality);
  const footCentre = cssString(`${meta.platformName} · generated ${generated}`);
  const marginFont = `font-family:${DOC.font};font-size:8pt;color:${DOC.muted}`;
  const firstPage = meta.cover ? `@page :first{margin:0;@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-center{content:none}@bottom-right{content:none}}` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.reportName)} - ${esc(meta.period)}</title>
<style>
@font-face{font-family:"Geist Variable";src:url(${GEIST_WOFF2_DATA_URI}) format("woff2");font-weight:100 900;font-display:swap}
@page{size:A4;margin:18mm 14mm 16mm 14mm;@top-left{content:"${header}";${marginFont}}@top-right{content:"${periodStr}";${marginFont}}@bottom-left{content:"${footLeft}";${marginFont};font-size:7.5pt}@bottom-center{content:"${footCentre}";${marginFont};font-size:7.5pt}@bottom-right{content:"Page " counter(page) " of " counter(pages);${marginFont}}}
${firstPage}
@page landscape{size:A4 landscape;margin:16mm 14mm}
:root{color-scheme:light;--ink:${DOC.ink};--ink2:${DOC.ink2};--muted:${DOC.muted};--subtle:${DOC.subtle};--surface:${DOC.surface};--surface2:${DOC.surface2};--surface3:${DOC.surface3};--border:${DOC.border};--border-strong:${DOC.borderStrong};--navy:${navy};--accent:${accent};--font:${DOC.font}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface2);font-family:var(--font);font-size:${TYPE.body};line-height:1.45;color:var(--ink);-webkit-font-smoothing:antialiased}
.sheet{max-width:1100px;margin:0 auto;background:var(--surface)}
@media screen{body{padding:24px 16px}.sheet{padding:0 0 32px;box-shadow:0 1px 3px rgba(9,9,11,.08);border-radius:8px;overflow:hidden}.exec,.chapter,.block,.appendix,.charts.rest{padding-left:32px;padding-right:32px}.cover{border-radius:8px 8px 0 0}}
h1,h2,h3{margin:0;font-weight:600;color:var(--navy);line-height:1.2}
h2{font-size:${TYPE.h2};margin:22px 0 8px;padding-left:12px;position:relative;break-after:avoid}
h2::before{content:"";position:absolute;left:0;top:3px;width:3px;height:14px;background:var(--accent);-webkit-print-color-adjust:exact;print-color-adjust:exact}
h3{font-size:${TYPE.h3};color:var(--ink);margin:14px 0 6px;break-after:avoid}
p{margin:0 0 8px}
.muted{color:var(--muted);font-size:${TYPE.small}}
.caption{font-size:${TYPE.caption};text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.intro{color:var(--ink2);font-size:${TYPE.small};margin:0 0 8px}
.cover{height:297mm;padding:38mm 22mm 24mm 30mm;border-left:14mm solid var(--accent);display:flex;flex-direction:column;break-after:page;page-break-after:always;background:var(--surface);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover-brand img{height:14mm;width:auto}
.cover-main{margin-top:28mm}
.kicker{font-size:${TYPE.small};text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
.cover h1{font-size:${TYPE.h1};margin:8px 0 10px;max-width:140mm;line-height:1.1}
.cover-customer{font-size:15pt;color:var(--ink2);font-weight:500}
.cover-period{font-size:11pt;color:var(--muted);margin-top:4px}
.cover-desc{max-width:125mm;color:var(--ink2);margin-top:14px}
.cover-contents{margin-top:auto}
.cover-contents ol{margin:6px 0 0;padding-left:18px;columns:2;column-gap:28px;font-size:${TYPE.small};line-height:1.8;color:var(--ink2)}
.cover-conf{margin-top:14px;font-size:${TYPE.caption};color:var(--muted)}
.cover-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:${TYPE.small};color:var(--muted)}
.exec.after-cover{break-before:page;page-break-before:always}
.mast{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:0 0 10px;border-bottom:1px solid var(--border)}
.mast img{height:9mm;width:auto}
.mast-right{text-align:right;font-size:${TYPE.small};color:var(--ink2)}
.mast-title{font-size:${TYPE.h2};font-weight:600;color:var(--navy)}
.lede{font-size:11pt;color:var(--ink2);margin:0 0 12px;max-width:170mm}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 12px}
.tiles.more{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.tile{border:1px solid var(--border);border-radius:6px;padding:10px 12px;background:var(--surface);break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.tile.good{border-left:3px solid ${STATUS.good}}.tile.warn{border-left:3px solid ${STATUS.warning}}.tile.bad{border-left:3px solid ${STATUS.critical}}
.tile .label{font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.tile .row{display:flex;justify-content:space-between;align-items:flex-end;gap:8px}
.tile .value{font-size:${TYPE.tile};font-weight:600;line-height:1.2;margin-top:2px;color:var(--ink)}
.tile.compact .value{font-size:14pt}.tile.compact{padding:7px 10px}
.tile .delta{font-size:8.5pt;font-weight:600;margin-top:2px;display:flex;align-items:center;gap:4px}
.tile .delta .vs{font-weight:400;color:var(--muted)}
.tile .hint{font-size:8.5pt;color:var(--muted);margin-top:2px}
.tile .target{color:var(--muted)}
.narrative{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:4px 0 12px;break-inside:avoid}
.narrative h3{display:flex;align-items:center;gap:6px;margin:0 0 6px;font-size:${TYPE.h3}}
.narrative ul,.narrative ol{margin:0;padding:0 0 0 2px;list-style:none;font-size:${TYPE.small};color:var(--ink)}
.narrative ol{counter-reset:step}
.narrative li{display:flex;gap:6px;margin:0 0 6px;line-height:1.4}
.narrative ol li::before{counter-increment:step;content:counter(step) ".";color:var(--muted);min-width:12px}
.narrative .glyph{flex:none;margin-top:4px}
.glyph{display:inline-block;vertical-align:middle}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:6px 0 10px}
.charts .full{grid-column:1 / -1}
figure.chart{margin:0;border:1px solid var(--border);border-radius:6px;padding:10px 12px;break-inside:avoid;page-break-inside:avoid;background:var(--surface)}
figure.chart figcaption b{font-size:${TYPE.small};font-weight:600;color:var(--ink)}
figure.chart figcaption span{display:block;font-size:${TYPE.caption};color:var(--muted)}
figure.chart svg{display:block;width:100%;height:auto;margin-top:6px}
figure.chart.gauge svg{max-width:240px;margin:6px auto 0}
figure.chart .empty{padding:28px 0;text-align:center;color:var(--muted);font-size:${TYPE.small}}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:${TYPE.caption};color:var(--muted);margin-top:4px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.legend small{margin-left:4px;color:var(--subtle)}
.callouts{list-style:none;margin:0 0 10px;padding:0}
.callouts li{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;margin:0 0 4px;border-left:3px solid var(--border);background:var(--surface2);font-size:${TYPE.small};break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.callouts li.good{border-left-color:${STATUS.good}}.callouts li.attention{border-left-color:${STATUS.warning}}.callouts li.info{border-left-color:${CATEGORICAL[0]}}
.callouts .glyph{margin-top:3px;flex:none}.callouts em{font-style:normal;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:${TYPE.small};margin:4px 0 6px}
thead{display:table-header-group}
th{text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);background:var(--surface3);padding:5px 6px;border-bottom:1px solid var(--border-strong);white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact}
td{padding:4px 6px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:break-word}
tbody tr:nth-child(even) td{background:var(--surface2);-webkit-print-color-adjust:exact;print-color-adjust:exact}
tr{break-inside:avoid;page-break-inside:avoid}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nw{white-space:nowrap}
tfoot{display:table-row-group}
tfoot td{font-weight:600;border-top:1px solid var(--border-strong);border-bottom:0;background:var(--surface)}
tfoot tr{break-before:avoid;page-break-before:avoid}
.lead{break-after:avoid;page-break-after:avoid}
.lead.keep{break-inside:avoid;page-break-inside:avoid}
.lead .intro{break-after:avoid;page-break-after:avoid}
.dense table{font-size:8pt}.dense td{padding:3px 4px}.dense th{font-size:7.5pt;padding:4px 4px;white-space:normal}
.note{margin:2px 0 8px}
.block,.chapter{margin:0 0 6px}
.appendix{margin-top:18px}
.defs,.about{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;margin:0;font-size:${TYPE.small}}
.defs div,.about div{display:flex;gap:8px;break-inside:avoid}
.defs dt,.about dt{min-width:34%;font-weight:600;color:var(--ink2)}
.defs dd,.about dd{margin:0;color:var(--ink2)}
.about{grid-template-columns:1fr}
.notes{margin:0;padding-left:16px;font-size:${TYPE.small};color:var(--ink2)}
.pills{margin:0 0 8px}
.pill{display:inline-block;background:var(--surface3);color:var(--ink2);border-radius:999px;padding:2px 8px;font-size:${TYPE.caption};margin:0 6px 6px 0}
@media print{body{background:var(--surface);padding:0}.sheet{max-width:none;box-shadow:none;border-radius:0}.wide{page:landscape}.wide h2,.wide h3{margin-top:0}.wide td{font-size:8pt;padding:3px 5px}.wide th{font-size:8pt;padding:4px 5px}.charts.headline{break-inside:avoid;page-break-inside:avoid}}
@media (max-width:640px){.tiles,.tiles.more,.narrative,.charts{grid-template-columns:1fr}.charts .full{grid-column:auto}.defs{grid-template-columns:1fr}.cover{height:auto;min-height:0;padding:28px 20px;border-left-width:10px}.mast{flex-direction:column}.mast-right{text-align:left}}
</style></head><body><div class="sheet">
${cover}
${exec.replace('<section class="exec', `<section class="exec${pack ? ' pack' : ''}`)}
${restCharts.length ? `<section class="block charts-block"><h2 id="charts">Charts</h2><div class="charts rest">${restCharts.map((c) => renderChart(c)).join('')}</div></section>` : ''}
<section class="block${detail.wide ? ' wide' : ''}"><h2 id="${sectionId(detailTitle)}">${detailTitle}${pack ? '' : ` (${rowCount} ${rowCount === 1 ? 'row' : 'rows'})`}</h2>${detail.html}</section>
${chaptersHtml}
${appendix}
</div></body></html>`;
}
