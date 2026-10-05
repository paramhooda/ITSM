import { escapeHtml } from '@/lib/templates';
import type { ReportChart, ValueUnit } from '../registry';
import { CATEGORICAL, DEEMPHASIS, DOC, SEQUENTIAL, STATUS, STATUS_SERIES } from './tokens';

/**
 * Server-side SVG charts for the report document: no browser script, no
 * external asset. Seven kinds (bar, horizontal bar, stacked bar, line, donut,
 * heatmap, gauge) plus the tile sparkline, all drawn with the validated
 * palette and the mark rules of the design system: one axis, marks at most
 * 24 px thick with a rounded data end and a square baseline, 2 px lines with
 * round joins, end dots with a white ring, hairline solid gridlines, direct
 * labels used sparingly, a legend for two or more series, never a number in
 * a data colour.
 */

export interface ChartOpts {
  width?: number;
  height?: number;
}

/** Default viewBox sizes: a half-width chart prints at about 88 mm (333 px), a full one at about 182 mm, so text keeps its size on paper. */
const HALF = { width: 340, height: 180 };
const FULL = { width: 700, height: 210 };
const MAX_BAR = 24;
const GAP = 2;
const MAX_SERIES = 4;
const FONT = `font-family='${DOC.font.replace(/'/g, '')}'`;

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmtNum = (v: number) => (Number.isInteger(v) ? v.toLocaleString('en-US') : round1(v).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (v: unknown) => escapeHtml(String(v ?? ''));
const n1 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** A value with its unit: 96.4 and pct give "96.4%", 42 and minutes "42 min", 4.2 and rating "4.2/5", 7.5 and hours "7.5 h". */
export function fmtUnit(v: number, unit?: ValueUnit): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'pct':
      return `${fmtNum(round1(v))}%`;
    case 'minutes':
      return `${fmtNum(Math.round(v))} min`;
    case 'hours':
      return `${fmtNum(round1(v))} h`;
    case 'rating':
      return `${round1(v)}/5`;
    default:
      return fmtNum(v);
  }
}

/** Short axis tick text: thousands separated, pct with the sign. */
const fmtTick = (v: number, unit?: ValueUnit) => (unit === 'pct' ? `${fmtNum(v)}%` : fmtNum(v));

/** Clean axis ticks from 0 to at least `max`: a step of 1, 2 or 5 times a power of ten, about five ticks. */
export function niceTicks(max: number, count = 5, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const p = 10 ** Math.floor(Math.log10(rough));
  const n = rough / p;
  // counts never get a fractional axis: the step is at least one
  const step = Math.max(integer ? 1 : 0, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  const ticks: number[] = [];
  for (let v = 0; ticks.length < 20; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
    if (v >= max) break;
  }
  return ticks;
}

const seriesOf = (chart: ReportChart) => (Array.isArray(chart.y) ? chart.y : [chart.y]);
const seriesLabel = (chart: ReportChart, k: string) => chart.labels?.[k] ?? (k === 'Other' ? 'Other' : k);
const numeric = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A series beyond the fourth is folded into one `Other` series (summed) so no fifth hue is ever needed. */
function foldSeries(chart: ReportChart): { series: string[]; data: Record<string, unknown>[] } {
  const series = seriesOf(chart);
  if (series.length <= MAX_SERIES) return { series, data: chart.data };
  const keep = series.slice(0, MAX_SERIES);
  const rest = series.slice(MAX_SERIES);
  return { series: [...keep, 'Other'], data: chart.data.map((d) => ({ ...d, Other: rest.reduce((s, k) => s + (numeric(d[k]) ?? 0), 0) })) };
}

/** The hue of a series: status colours when the chart says so, otherwise the categorical slot (Other always wears the gray). */
function seriesColor(chart: ReportChart, key: string, index: number, total: number): string {
  if (key === 'Other') return DEEMPHASIS;
  if (chart.statusSeries) return STATUS_SERIES[key.toLowerCase()] ?? DEEMPHASIS;
  if (chart.emphasis && total > 1) return key === chart.emphasis ? CATEGORICAL[0] : DEEMPHASIS;
  return CATEGORICAL[Math.min(index, CATEGORICAL.length - 1)];
}

/** The hue of a category bar on a single-series chart: emphasis singles one out, status charts colour by the category key. */
function categoryColor(chart: ReportChart, label: string): string {
  if (chart.statusSeries) return STATUS_SERIES[label.toLowerCase().replace(/[\s-]+/g, '_')] ?? DEEMPHASIS;
  if (chart.emphasis) return label === chart.emphasis ? CATEGORICAL[0] : DEEMPHASIS;
  return CATEGORICAL[0];
}

const legendHtml = (items: { label: string; color: string; note?: string; line?: boolean }[]) => (items.length ? `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}${i.line ? ';height:2px;border-radius:0' : ''}"></i>${esc(i.label)}${i.note ? `<small>${esc(i.note)}</small>` : ''}</span>`).join('')}</div>` : '');
/** The target hairline is named in the legend rather than on the plot, where a label would collide with the bars. */
const targetLegend = (chart: ReportChart) => (chart.target !== undefined ? [{ label: `Target ${fmtUnit(chart.target, chart.unit)}`, color: DOC.ink2, line: true }] : []);

function figure(chart: ReportChart, body: string, legend = '', extraClass = ''): string {
  const width = chart.width === 'full' ? 'full' : 'half';
  return `<figure class="chart ${width}${extraClass ? ` ${extraClass}` : ''}"><figcaption><b>${esc(chart.title)}</b>${chart.subtitle ? `<span>${esc(chart.subtitle)}</span>` : ''}</figcaption>${body}${legend}</figure>`;
}

const svgOpen = (w: number, h: number, title: string) => `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}" ${FONT}>`;

const emptyFigure = (chart: ReportChart) => figure(chart, `<div class="empty">No data</div>`);

const dims = (chart: ReportChart, opts?: ChartOpts) => ({ width: opts?.width ?? (chart.width === 'full' ? FULL.width : HALF.width), height: opts?.height ?? (chart.width === 'full' ? FULL.height : HALF.height) });

/** Vertical bar with a rounded data end and a square baseline (a rect with rx plus a square patch at the base). */
function vBar(x: number, y: number, w: number, h: number, color: string, title: string, cls = 'bar'): string {
  const main = `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"><title>${esc(title)}</title></rect>`;
  const base = h > 3 ? `<rect class="base" x="${x.toFixed(1)}" y="${(y + h - 3).toFixed(1)}" width="${w.toFixed(1)}" height="3" fill="${color}"/>` : '';
  return main + base;
}
/** Horizontal bar: rounded tip on the right, square at the left baseline. */
function hBar(x: number, y: number, w: number, h: number, color: string, title: string, cls = 'bar'): string {
  const main = `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"><title>${esc(title)}</title></rect>`;
  const base = w > 3 ? `<rect class="base" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="3" height="${h.toFixed(1)}" fill="${color}"/>` : '';
  return main + base;
}

// ---------------------------------------------------------------- bar

export function barChart(chart: ReportChart, opts?: ChartOpts): string {
  const { series, data: all } = foldSeries(chart);
  const data = all.slice(0, 40);
  if (!data.length) return emptyFigure(chart);
  const labels = data.map((d) => String(d[chart.x] ?? ''));
  const horizontal = chart.horizontal === true || labels.some((l) => l.length > 14) || data.length > 8;
  return horizontal ? horizontalBars(chart, series, data, labels, opts) : verticalBars(chart, series, data, labels, opts);
}

function verticalBars(chart: ReportChart, series: string[], data: Record<string, unknown>[], labels: string[], opts?: ChartOpts): string {
  const { width, height } = dims(chart, opts);
  const m = { top: 18, right: 12, bottom: 38, left: 46 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const values = data.flatMap((d) => series.map((k) => numeric(d[k]) ?? 0));
  const ticks = niceTicks(Math.max(0, ...values, chart.target ?? 0), 5, values.every((v) => Number.isInteger(v)));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => m.top + plotH - (Math.max(0, v) / yMax) * plotH;
  const parts: string[] = [];
  for (const t of ticks) parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${DOC.gridline}" stroke-width="1"/>`, `<text x="${m.left - 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.axisText}">${fmtTick(t, chart.unit)}</text>`);
  if (chart.target !== undefined) parts.push(`<line class="target" x1="${m.left}" x2="${width - m.right}" y1="${y(chart.target).toFixed(1)}" y2="${y(chart.target).toFixed(1)}" stroke="${DOC.ink2}" stroke-width="1"/>`);
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(MAX_BAR, (slot - 8) / series.length - GAP));
  const groupW = series.length * barW + (series.length - 1) * GAP;
  const directLabels = data.length * series.length <= 16;
  data.forEach((d, i) => {
    const x0 = m.left + i * slot + (slot - groupW) / 2;
    series.forEach((k, si) => {
      const v = numeric(d[k]) ?? 0;
      const x = x0 + si * (barW + GAP);
      const top = y(v);
      const color = series.length === 1 ? categoryColor(chart, labels[i]!) : seriesColor(chart, k, si, series.length);
      parts.push(vBar(x, top, barW, Math.max(0, m.top + plotH - top), color, `${labels[i]}${series.length > 1 ? ` · ${seriesLabel(chart, k)}` : ''}: ${fmtUnit(v, chart.unit)}`));
      if (directLabels) parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="${DOC.ink2}">${fmtUnit(v, chart.unit)}</text>`);
    });
    parts.push(`<text x="${(m.left + i * slot + slot / 2).toFixed(1)}" y="${height - m.bottom + 14}" font-size="9" text-anchor="middle" fill="${DOC.axisText}">${esc(trunc(labels[i]!, 14))}</text>`);
  });
  parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${(m.top + plotH).toFixed(1)}" y2="${(m.top + plotH).toFixed(1)}" stroke="${DOC.baseline}" stroke-width="1"/>`);
  const legend = legendHtml([...(series.length > 1 ? series.map((k, i) => ({ label: seriesLabel(chart, k), color: seriesColor(chart, k, i, series.length) })) : []), ...targetLegend(chart)]);
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, legend);
}

function horizontalBars(chart: ReportChart, series: string[], data: Record<string, unknown>[], labels: string[], opts?: ChartOpts): string {
  const width = opts?.width ?? (chart.width === 'full' ? FULL.width : HALF.width);
  const rowH = series.length > 1 ? Math.min(MAX_BAR + GAP, 16) * series.length + 10 : 24;
  const height = opts?.height ?? Math.max(90, 10 + data.length * rowH + 26);
  const longest = Math.max(...labels.map((l) => Math.min(l.length, 24)));
  const m = { top: 10, right: 44, bottom: 24, left: Math.min(width * 0.38, Math.max(50, longest * 5.2 + 12)) };
  const plotW = width - m.left - m.right;
  const values = data.flatMap((d) => series.map((k) => numeric(d[k]) ?? 0));
  const ticks = niceTicks(Math.max(0, ...values, chart.target ?? 0), 5, values.every((v) => Number.isInteger(v)));
  const xMax = ticks[ticks.length - 1]!;
  const x = (v: number) => m.left + (Math.max(0, v) / xMax) * plotW;
  const parts: string[] = [];
  const baseY = m.top + data.length * rowH;
  for (const t of ticks) parts.push(`<line y1="${m.top}" y2="${baseY}" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" stroke="${DOC.gridline}" stroke-width="1"/>`, `<text y="${baseY + 14}" x="${x(t).toFixed(1)}" font-size="9" text-anchor="middle" fill="${DOC.axisText}">${fmtTick(t, chart.unit)}</text>`);
  if (chart.target !== undefined) parts.push(`<line class="target" y1="${m.top}" y2="${baseY}" x1="${x(chart.target).toFixed(1)}" x2="${x(chart.target).toFixed(1)}" stroke="${DOC.ink2}" stroke-width="1"/>`);
  const barH = Math.max(3, Math.min(MAX_BAR, series.length > 1 ? (rowH - 10) / series.length - GAP : rowH - 8));
  const groupH = series.length * barH + (series.length - 1) * GAP;
  data.forEach((d, i) => {
    const y0 = m.top + i * rowH + (rowH - groupH) / 2;
    series.forEach((k, si) => {
      const v = numeric(d[k]) ?? 0;
      const yy = y0 + si * (barH + GAP);
      const w = Math.max(0, x(v) - m.left);
      const color = series.length === 1 ? categoryColor(chart, labels[i]!) : seriesColor(chart, k, si, series.length);
      parts.push(hBar(m.left, yy, w, barH, color, `${labels[i]}${series.length > 1 ? ` · ${seriesLabel(chart, k)}` : ''}: ${fmtUnit(v, chart.unit)}`));
      parts.push(`<text x="${(m.left + w + 4).toFixed(1)}" y="${(yy + barH / 2 + 3).toFixed(1)}" font-size="9" text-anchor="start" fill="${DOC.ink2}">${fmtUnit(v, chart.unit)}</text>`);
    });
    parts.push(`<text x="${m.left - 6}" y="${(y0 + groupH / 2 + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.axisText}">${esc(trunc(labels[i]!, 24))}</text>`);
  });
  parts.push(`<line y1="${m.top}" y2="${baseY}" x1="${m.left}" x2="${m.left}" stroke="${DOC.baseline}" stroke-width="1"/>`);
  const legend = legendHtml([...(series.length > 1 ? series.map((k, i) => ({ label: seriesLabel(chart, k), color: seriesColor(chart, k, i, series.length) })) : []), ...targetLegend(chart)]);
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, legend, 'horizontal');
}

// ---------------------------------------------------------------- stacked bar

export function stackedBarChart(chart: ReportChart, opts?: ChartOpts): string {
  const { series, data: all } = foldSeries(chart);
  const data = all.slice(0, 40);
  if (!data.length) return emptyFigure(chart);
  const { width, height } = dims(chart, opts);
  const m = { top: 18, right: 12, bottom: 38, left: 46 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const labels = data.map((d) => String(d[chart.x] ?? ''));
  const totals = data.map((d) => series.reduce((s, k) => s + Math.max(0, numeric(d[k]) ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals), 5, totals.every((v) => Number.isInteger(v)));
  const yMax = ticks[ticks.length - 1]!;
  const scale = (v: number) => (Math.max(0, v) / yMax) * plotH;
  const parts: string[] = [];
  for (const t of ticks) parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${(m.top + plotH - scale(t)).toFixed(1)}" y2="${(m.top + plotH - scale(t)).toFixed(1)}" stroke="${DOC.gridline}" stroke-width="1"/>`, `<text x="${m.left - 6}" y="${(m.top + plotH - scale(t) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.axisText}">${fmtTick(t, chart.unit)}</text>`);
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(MAX_BAR, slot - 8));
  // at most one label per 60 px of plot width (a date label is about 55 px wide)
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 60))));
  data.forEach((d, i) => {
    const x = m.left + i * slot + (slot - barW) / 2;
    let cum = 0;
    series.forEach((k, si) => {
      const v = Math.max(0, numeric(d[k]) ?? 0);
      if (v <= 0) return;
      const h = scale(v);
      const top = m.top + plotH - cum - h;
      // every segment ends GAP pixels before the next one starts: the surface does the separating
      const drawn = Math.max(0, h - (cum > 0 ? GAP : 0));
      parts.push(`<rect class="seg" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${drawn.toFixed(1)}" fill="${seriesColor(chart, k, si, series.length)}"><title>${esc(`${labels[i]} · ${seriesLabel(chart, k)}: ${fmtUnit(v, chart.unit)}`)}</title></rect>`);
      cum += h;
    });
    if (totals[i]! > 0 && data.length <= 16) parts.push(`<text class="total" x="${(x + barW / 2).toFixed(1)}" y="${(m.top + plotH - cum - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="${DOC.ink2}">${fmtUnit(totals[i]!, chart.unit)}</text>`);
    if (i % labelEvery === 0) parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${height - m.bottom + 14}" font-size="9" text-anchor="middle" fill="${DOC.axisText}">${esc(trunc(labels[i]!, 12))}</text>`);
  });
  parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${(m.top + plotH).toFixed(1)}" y2="${(m.top + plotH).toFixed(1)}" stroke="${DOC.baseline}" stroke-width="1"/>`);
  const legend = legendHtml(series.map((k, i) => ({ label: seriesLabel(chart, k), color: seriesColor(chart, k, i, series.length) })));
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, legend);
}

// ---------------------------------------------------------------- line

export function lineChart(chart: ReportChart, opts?: ChartOpts): string {
  const series = seriesOf(chart).slice(0, MAX_SERIES);
  const data = chart.data.slice(0, 400);
  if (!data.length) return emptyFigure(chart);
  const { width, height } = dims(chart, opts);
  const m = { top: 14, right: 58, bottom: 30, left: 46 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const values = data.flatMap((d) => series.map((k) => numeric(d[k]))).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.max(0, ...values, chart.target ?? 0), 5, values.every((v) => Number.isInteger(v)));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => m.top + plotH - (Math.max(0, v) / yMax) * plotH;
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;
  const x = (i: number) => m.left + i * step;
  const parts: string[] = [];
  for (const t of ticks) parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${DOC.gridline}" stroke-width="1"/>`, `<text x="${m.left - 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.axisText}">${fmtTick(t, chart.unit)}</text>`);
  if (chart.target !== undefined) parts.push(`<line class="target" x1="${m.left}" x2="${width - m.right}" y1="${y(chart.target).toFixed(1)}" y2="${y(chart.target).toFixed(1)}" stroke="${DOC.ink2}" stroke-width="1"/>`);
  const dots = data.length <= 24;
  series.forEach((k, si) => {
    const color = seriesColor(chart, k, si, series.length);
    // null values break the line: one polyline per contiguous run
    let run: string[] = [];
    const flush = () => {
      if (run.length > 1) parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      run = [];
    };
    data.forEach((d, i) => {
      const v = numeric(d[k]);
      if (v === null) return flush();
      run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    flush();
    if (dots) data.forEach((d, i) => {
      const v = numeric(d[k]);
      if (v !== null) parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color}" stroke="#fff" stroke-width="2"><title>${esc(`${d[chart.x]} · ${seriesLabel(chart, k)}: ${fmtUnit(v, chart.unit)}`)}</title></circle>`);
    });
    // the end point: a dot with a white ring and the value beside it
    let last = data.length - 1;
    while (last >= 0 && numeric(data[last]![k]) === null) last--;
    if (last >= 0) {
      const v = numeric(data[last]![k])!;
      parts.push(`<circle class="end" cx="${x(last).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="2"><title>${esc(`${data[last]![chart.x]} · ${seriesLabel(chart, k)}: ${fmtUnit(v, chart.unit)}`)}</title></circle>`);
      parts.push(`<text x="${(x(last) + 7).toFixed(1)}" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="${DOC.ink2}">${fmtUnit(v, chart.unit)}</text>`);
    }
  });
  // at most eight x labels, fewer when the labels are wide (about 5.4 px per character at 9 px)
  const labelW = Math.min(12, Math.max(...data.map((d) => String(d[chart.x] ?? '').length))) * 5.4 + 12;
  const every = Math.max(Math.ceil(data.length / 8), Math.ceil(data.length / Math.max(1, Math.floor(plotW / labelW))));
  data.forEach((d, i) => {
    if (i % every === 0) parts.push(`<text x="${x(i).toFixed(1)}" y="${height - m.bottom + 14}" font-size="9" text-anchor="${i === 0 ? 'start' : 'middle'}" fill="${DOC.axisText}">${esc(trunc(String(d[chart.x] ?? ''), 12))}</text>`);
  });
  parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${(m.top + plotH).toFixed(1)}" y2="${(m.top + plotH).toFixed(1)}" stroke="${DOC.baseline}" stroke-width="1"/>`);
  const legend = legendHtml([...(series.length > 1 ? series.map((k, i) => ({ label: seriesLabel(chart, k), color: seriesColor(chart, k, i, series.length) })) : []), ...targetLegend(chart)]);
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, legend);
}

// ---------------------------------------------------------------- donut

const MAX_SLICES = 6;

/** Donuts show one series of shares: at most six slices plus Other, a centre total, and a legend with value and share. Close values fall back to a horizontal bar, which compares lengths better than angles. */
export function donutChart(chart: ReportChart, opts?: ChartOpts): string {
  const key = seriesOf(chart)[0]!;
  const items = chart.data.map((d) => ({ label: String(d[chart.x] ?? ''), value: Math.max(0, numeric(d[key]) ?? 0) })).filter((i) => i.value > 0);
  if (!items.length) return emptyFigure(chart);
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length > 1 && sorted[1]!.value >= sorted[0]!.value * 0.9) return barChart({ ...chart, type: 'bar', horizontal: true, data: items.map((i) => ({ [chart.x]: i.label, [key]: i.value })) }, opts);
  let slices = items;
  if (items.length > MAX_SLICES) {
    const keep = new Set(sorted.slice(0, MAX_SLICES).map((i) => i.label));
    const other = items.filter((i) => !keep.has(i.label)).reduce((s, i) => s + i.value, 0);
    slices = [...items.filter((i) => keep.has(i.label)), { label: 'Other', value: other }];
  }
  const total = slices.reduce((s, i) => s + i.value, 0);
  const { width, height } = dims(chart, opts);
  const r = Math.min(72, height / 2 - 12), ri = r * 0.62, cx = r + 12, cy = height / 2;
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  const colorOf = (label: string, i: number) => (label === 'Other' ? DEEMPHASIS : chart.statusSeries ? STATUS_SERIES[label.toLowerCase().replace(/[\s-]+/g, '_')] ?? DEEMPHASIS : chart.emphasis ? (label === chart.emphasis ? CATEGORICAL[0] : DEEMPHASIS) : CATEGORICAL[Math.min(i, CATEGORICAL.length - 1)]);
  slices.forEach((s, i) => {
    const share = s.value / total;
    const color = colorOf(s.label, i);
    const title = `${s.label}: ${fmtUnit(s.value, chart.unit)} (${round1(share * 100)}%)`;
    if (share >= 0.9999) {
      parts.push(`<circle class="slice" cx="${cx}" cy="${cy.toFixed(1)}" r="${((r + ri) / 2).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(r - ri).toFixed(1)}"><title>${esc(title)}</title></circle>`);
      return;
    }
    const a0 = angle, a1 = angle + share * 2 * Math.PI;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    parts.push(`<path class="slice" d="M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${p(ri, a0)} Z" fill="${color}" stroke="${DOC.surface}" stroke-width="2"><title>${esc(title)}</title></path>`);
  });
  parts.push(`<text class="centre" x="${cx}" y="${(cy + 2).toFixed(1)}" font-size="22" font-weight="600" text-anchor="middle" fill="${DOC.ink}">${fmtUnit(total, chart.unit)}</text>`);
  parts.push(`<text x="${cx}" y="${(cy + 18).toFixed(1)}" font-size="9" text-anchor="middle" fill="${DOC.muted}">total</text>`);
  // the legend lives inside the SVG so it prints beside the ring
  const lx = cx + r + 18;
  const rowH = Math.min(20, (height - 16) / slices.length);
  const labelChars = Math.max(8, Math.floor((width - lx - 16 - 58) / 4.8));
  slices.forEach((s, i) => {
    const yy = cy - ((slices.length - 1) * rowH) / 2 + i * rowH;
    parts.push(`<rect x="${lx}" y="${(yy - 5).toFixed(1)}" width="10" height="10" rx="2" fill="${colorOf(s.label, i)}"/>`);
    parts.push(`<text x="${lx + 15}" y="${(yy + 3.5).toFixed(1)}" font-size="9" fill="${DOC.ink2}">${esc(trunc(s.label, labelChars))}</text>`);
    parts.push(`<text x="${width - 8}" y="${(yy + 3.5).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.muted}">${fmtUnit(s.value, chart.unit)} · ${round1((s.value / total) * 100)}%</text>`);
  });
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, '', 'donut');
}

// ---------------------------------------------------------------- heatmap

/** rows x cols grid of { row, col, value }; the sequential ramp is assigned by quantile over the non-zero values, zero cells stay on the surface. */
export function heatmap(chart: ReportChart, opts?: ChartOpts): string {
  const key = seriesOf(chart)[0]!;
  const cells = chart.data.map((d) => ({ row: String(d.row ?? ''), col: String(d.col ?? ''), value: Math.max(0, numeric(d[key]) ?? 0) }));
  if (!cells.length) return emptyFigure(chart);
  const rows = chart.rows ?? [...new Set(cells.map((c) => c.row))];
  const cols = chart.cols ?? [...new Set(cells.map((c) => c.col))];
  const lookup = new Map(cells.map((c) => [`${c.row}\u0000${c.col}`, c.value]));
  const width = opts?.width ?? (chart.width === 'half' ? HALF.width : FULL.width);
  const m = { top: 20, right: 8, bottom: 30, left: 34 };
  const cellW = Math.min(36, (width - m.left - m.right) / cols.length);
  const cellH = Math.min(22, Math.max(14, cellW * 0.72));
  const height = opts?.height ?? m.top + rows.length * cellH + m.bottom;
  const nonZero = cells.map((c) => c.value).filter((v) => v > 0).sort((a, b) => a - b);
  const thresholds = nonZero.length ? [1, 2, 3, 4, 5].map((k) => nonZero[Math.min(nonZero.length - 1, Math.floor((k / 6) * nonZero.length))]!) : [];
  const binOf = (v: number) => (v <= 0 || !nonZero.length ? -1 : Math.min(SEQUENTIAL.length - 1, thresholds.filter((t) => t <= v).length));
  const parts: string[] = [];
  cols.forEach((c, j) => {
    if (cols.length <= 12 || j % 2 === 0) parts.push(`<text x="${(m.left + j * cellW + cellW / 2).toFixed(1)}" y="${m.top - 6}" font-size="8" text-anchor="middle" fill="${DOC.axisText}">${esc(trunc(c, 6))}</text>`);
  });
  rows.forEach((r, i) => {
    parts.push(`<text x="${m.left - 6}" y="${(m.top + i * cellH + cellH / 2 + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${DOC.axisText}">${esc(trunc(r, 6))}</text>`);
    cols.forEach((c, j) => {
      const v = lookup.get(`${r}\u0000${c}`) ?? 0;
      const bin = binOf(v);
      const fill = bin < 0 ? DOC.surface : SEQUENTIAL[bin]!;
      const x = m.left + j * cellW, y = m.top + i * cellH;
      parts.push(`<rect class="cell" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW - 1).toFixed(1)}" height="${(cellH - 1).toFixed(1)}" fill="${fill}" stroke="${bin < 0 ? DOC.border : fill}" stroke-width="${bin < 0 ? 0.5 : 0}"><title>${esc(`${r} ${c}: ${fmtUnit(v, chart.unit)}`)}</title></rect>`);
      if (v >= 1 && cellW >= 18) parts.push(`<text x="${(x + (cellW - 1) / 2).toFixed(1)}" y="${(y + cellH / 2 + 2.5).toFixed(1)}" font-size="7.5" text-anchor="middle" fill="${bin >= 3 ? '#ffffff' : DOC.ink2}">${fmtNum(v)}</text>`);
    });
  });
  // scale legend: the ramp from low to high with the extreme values
  const ly = height - 12;
  const lx = m.left;
  parts.push(`<text x="${lx}" y="${ly + 3}" font-size="8" fill="${DOC.axisText}">${nonZero.length ? fmtNum(nonZero[0]!) : 0}</text>`);
  SEQUENTIAL.forEach((c, i) => parts.push(`<rect x="${lx + 24 + i * 14}" y="${ly - 4}" width="13" height="8" fill="${c}"/>`));
  parts.push(`<text x="${lx + 24 + SEQUENTIAL.length * 14 + 4}" y="${ly + 3}" font-size="8" fill="${DOC.axisText}">${nonZero.length ? fmtNum(nonZero[nonZero.length - 1]!) : 0}</text>`);
  return figure({ ...chart, width: chart.width ?? 'full' }, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, '', 'heatmap');
}

// ---------------------------------------------------------------- gauge

/** Half ring with the value as the hero figure, a target tick, and a fill coloured by distance from the target. */
export function gauge(chart: ReportChart, opts?: ChartOpts): string {
  const key = seriesOf(chart)[0]!;
  const d = chart.data[0];
  const value = d ? numeric(d[key]) : null;
  if (value === null) return emptyFigure(chart);
  const target = chart.target;
  const unit = chart.unit ?? 'pct';
  const max = unit === 'pct' ? 100 : Math.max(value, target ?? 0) * 1.2 || 1;
  const width = opts?.width ?? 220, height = opts?.height ?? 150;
  const cx = width / 2, cy = height - 32, r = Math.min(cx - 14, cy - 10), ri = r - 22;
  const fill = target === undefined ? CATEGORICAL[0] : value >= target ? STATUS.good : value >= target - 5 ? STATUS.warning : STATUS.critical;
  const arc = (from: number, to: number, color: string, cls: string) => {
    const a0 = Math.PI + from * Math.PI, a1 = Math.PI + to * Math.PI;
    const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const large = to - from > 0.5 ? 1 : 0;
    return `<path class="${cls}" d="M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${p(ri, a0)} Z" fill="${color}"/>`;
  };
  const share = Math.max(0, Math.min(1, value / max));
  const parts: string[] = [arc(0, 1, DOC.surface3, 'track')];
  if (share > 0.001) parts.push(arc(0, share, fill, 'fill'));
  if (target !== undefined) {
    const a = Math.PI + Math.max(0, Math.min(1, target / max)) * Math.PI;
    parts.push(`<line class="target" x1="${(cx + (ri - 4) * Math.cos(a)).toFixed(2)}" y1="${(cy + (ri - 4) * Math.sin(a)).toFixed(2)}" x2="${(cx + (r + 4) * Math.cos(a)).toFixed(2)}" y2="${(cy + (r + 4) * Math.sin(a)).toFixed(2)}" stroke="${DOC.ink}" stroke-width="2"/>`);
  }
  parts.push(`<text class="hero" x="${cx}" y="${(cy - 6).toFixed(1)}" font-size="26" font-weight="600" text-anchor="middle" fill="${DOC.ink}">${fmtUnit(value, unit)}</text>`);
  parts.push(`<text x="${cx}" y="${(cy + 14).toFixed(1)}" font-size="9" text-anchor="middle" fill="${DOC.muted}">${target !== undefined ? `target ${fmtUnit(target, unit)}` : esc(String(d![chart.x] ?? ''))}</text>`);
  return figure(chart, `${svgOpen(width, height, chart.title)}${parts.join('')}</svg>`, '', 'gauge');
}

// ---------------------------------------------------------------- sparkline

/** A 96 x 28 sparkline for stat tiles: the line in the de-emphasis gray, the last point in the first categorical hue. */
export function sparkline(points: (number | null)[], opts: { width?: number; height?: number; accentLast?: boolean } = {}): string {
  const width = opts.width ?? 96, height = opts.height ?? 28;
  const vals = points.map((p) => (typeof p === 'number' && Number.isFinite(p) ? p : null));
  const present = vals.filter((v): v is number => v !== null);
  if (present.length < 2) return '';
  const min = Math.min(...present), max = Math.max(...present);
  const span = max - min || 1;
  const step = vals.length > 1 ? (width - 6) / (vals.length - 1) : 0;
  const x = (i: number) => 3 + i * step;
  const y = (v: number) => 3 + (height - 6) * (1 - (v - min) / span);
  const parts: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 1) parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${DEEMPHASIS}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    run = [];
  };
  vals.forEach((v, i) => {
    if (v === null) return flush();
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  flush();
  let last = vals.length - 1;
  while (last > 0 && vals[last] === null) last--;
  let prev = last - 1;
  while (prev >= 0 && vals[prev] === null) prev--;
  if (opts.accentLast !== false && prev >= 0) parts.push(`<line x1="${x(prev).toFixed(1)}" y1="${y(vals[prev]!).toFixed(1)}" x2="${x(last).toFixed(1)}" y2="${y(vals[last]!).toFixed(1)}" stroke="${CATEGORICAL[0]}" stroke-width="1.5" stroke-linecap="round"/>`);
  parts.push(`<circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]!).toFixed(1)}" r="2.5" fill="${CATEGORICAL[0]}"/>`);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------- dispatcher

export function renderChart(chart: ReportChart, opts?: ChartOpts): string {
  if (!chart.data?.length) return emptyFigure(chart);
  switch (chart.type) {
    case 'stacked_bar':
      return stackedBarChart(chart, opts);
    case 'line':
      return lineChart(chart, opts);
    case 'donut':
      return donutChart(chart, opts);
    case 'heatmap':
      return heatmap(chart, opts);
    case 'gauge':
      return gauge(chart, opts);
    default:
      return barChart(chart, opts);
  }
}
