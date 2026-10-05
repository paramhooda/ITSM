import type { Glossary, Insight, Narrative, Recommendation, ReportChart, ReportResult, SummaryTile, TileDelta, ValueUnit } from './registry';
import { fmtUnit } from './theme/charts';

/**
 * Deterministic insight rules over a report result: trends against the
 * previous period, targets, concentration, best and worst, outliers and clean
 * sheets. Every sentence is built from the figures; the model (narrative.ts)
 * only rephrases them and may never add a number. This module is pure so the
 * theme tests run without a database or a provider.
 */

const MAX_INSIGHTS = 8;
const round1 = (v: number) => Math.round(v * 10) / 10;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const DEFAULT_GLOSSARY: Glossary[] = [
  { term: 'SLA compliance', meaning: 'Resolution and response clocks met divided by clocks completed in the period' },
  { term: 'Breach', meaning: 'A clock that passed its target before completion' },
  { term: 'MTTA', meaning: 'Mean time from ticket creation to the first response, resolved tickets in the period' },
  { term: 'MTTR', meaning: 'Mean time from creation to resolution, tickets resolved in the period' },
  { term: 'First-contact resolution', meaning: 'Resolved without reassignment, escalation or a reopen' },
  { term: 'Reopen rate', meaning: 'Share of resolved tickets reopened at least once' },
  { term: 'Backlog', meaning: 'Tickets open at the end of the period' },
  { term: 'Previous period', meaning: 'The same number of days immediately before the period' },
  { term: 'Out of scope', meaning: 'Work the contract does not cover, classified on the ticket' },
  { term: 'Customer satisfaction', meaning: 'Average of the 1-5 survey ratings answered in the period; satisfied = 4 or 5' },
  { term: 'Change success rate', meaning: 'Implemented changes divided by implemented plus failed or backed out' },
  { term: 'Known error', meaning: 'A problem with an identified cause and a workaround' },
  { term: 'Entitlement utilisation', meaning: 'Consumed divided by the entitled quantity in the current window' },
];

/** "+4.3 pts" for percentage tiles, "+12%" otherwise, the absolute change when the previous value was zero, a dash when there is nothing to compare. */
export const fmtDelta = (d?: TileDelta | null): string => {
  if (!d || !isNum(d.change)) return '—';
  const sign = d.change > 0 ? '+' : d.change < 0 ? '−' : '±';
  const abs = Math.abs(d.change);
  if (d.unit === 'pct') return `${sign}${round1(abs)} pts`;
  if (!isNum(d.deltaPct)) return `${sign}${fmtUnit(abs, d.unit)}`;
  return `${sign}${round1(Math.abs(d.deltaPct))}%`;
};

/** A tile value with its unit: 96.4 and pct give "96.4%"; strings are printed as they are; null is a dash. */
export const fmtTileValue = (t: Pick<SummaryTile, 'value' | 'unit'>): string => (t.value === null || t.value === undefined ? '—' : isNum(t.value) ? fmtUnit(t.value, t.unit) : String(t.value));

/** Every number token in the JSON of the input, normalised (thousands separators removed, "96.40" and "96.4" alike), as strings. */
export function numbersIn(input: unknown): Set<string> {
  const text = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}

/** True when every number in `text` appears in `allowed` (the figures the rules computed). */
export function groundedAgainst(text: string, allowed: Set<string>): boolean {
  for (const n of numbersIn(text)) if (!allowed.has(n)) return false;
  return true;
}

// ---------------------------------------------------------------- areas

/** The area of a tile label or chart title, used to group insights and to pick a next step. */
export function areaOf(label: string): string {
  const l = label.toLowerCase();
  if (/compliance|breach|\bsla\b|response|resolution|acknowledg|restoration/.test(l)) return 'Service levels';
  if (/mtta|mttr|first-contact|first contact|reopen|backlog|\bage\b|ageing|responsiveness/.test(l)) return 'Responsiveness';
  if (/rating|satisf|csat|survey/.test(l)) return 'Satisfaction';
  if (/change|cab|success rate/.test(l)) return 'Changes';
  if (/entitle|utili[sz]|exhaust|consum/.test(l)) return 'Entitlements';
  if (/asset|warranty|\bamc\b|cover|licen|software|over-deployed|titles|install/.test(l)) return 'Assets';
  if (/known error|problem/.test(l)) return 'Problems';
  if (/visit|maintenance|\bpm\b|on-site|engineer/.test(l)) return 'Field service';
  if (/out of scope|out-of-scope|scope/.test(l)) return 'Scope';
  if (/opened|resolved|closed|volume|ticket|incident|request|arrival|category|service|priority|site|source|type/.test(l)) return 'Volume';
  return 'Service';
}

const NEXT_STEP_BY_AREA: Record<string, string> = {
  'Service levels': 'Review the breached tickets with the team lead and agree corrective actions',
  Volume: 'Check the top category for a recurring cause and raise a problem record',
  Responsiveness: 'Look at first-response delays on the priorities named above',
  Satisfaction: 'Call the customers behind the low ratings',
  Changes: 'Review the failed or backed-out changes at the next CAB',
  Entitlements: 'Discuss top-ups before the next review',
  Assets: 'Schedule the warranty and AMC renewals',
};

// ---------------------------------------------------------------- rules

const singleSeries = (c: ReportChart) => (Array.isArray(c.y) ? (c.y.length === 1 ? c.y[0]! : null) : c.y);
const allows = (c: ReportChart, rule: 'concentration' | 'extremes' | 'outliers') => (c.insight === 'none' ? false : Array.isArray(c.insight) ? c.insight.includes(rule) : c.type === 'bar' ? rule !== 'outliers' : c.type === 'line' ? rule === 'outliers' : false);
const numOf = (v: unknown): number | null => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** R1 trend: percentage tiles that moved by at least 3 points; other tiles that moved by at least 10% (and, for counts, by at least 3). */
function trendInsights(tiles: SummaryTile[], comparison: string | null | undefined): Insight[] {
  const out: Insight[] = [];
  for (const t of tiles) {
    const d = t.delta;
    if (!d || !isNum(d.previous) || !isNum(d.change) || !isNum(d.deltaPct) || !isNum(t.value)) continue;
    const unit = d.unit ?? t.unit ?? 'count';
    if (unit === 'pct' ? Math.abs(d.change) < 3 : Math.abs(d.deltaPct) < 10) continue;
    if (unit === 'count' && Math.abs(d.change) < 3) continue;
    const improved = d.lowerIsBetter ? d.change < 0 : d.change > 0;
    // a neutral figure (demand, a record count) is reported without a verdict and weighs less than a judged one
    out.push({ kind: d.neutral ? 'info' : improved ? 'good' : 'attention', area: areaOf(t.label), text: `${t.label} moved from ${fmtUnit(d.previous, unit)} to ${fmtUnit(t.value, unit)} (${fmtDelta({ ...d, unit: d.unit ?? t.unit })})${comparison ? ` against ${comparison}` : ''}`, evidence: `${t.label}: ${fmtUnit(d.previous, unit)} before, ${fmtUnit(t.value, unit)} now`, weight: (d.neutral ? 6 : 10) + Math.abs(d.deltaPct) / 10 });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

/** R2 target: tiles judged against a target. */
function targetInsights(tiles: SummaryTile[]): Insight[] {
  const out: Insight[] = [];
  for (const t of tiles) {
    if (!isNum(t.target) || !isNum(t.value)) continue;
    const lower = t.delta?.lowerIsBetter === true;
    const meets = lower ? t.value <= t.target : t.value >= t.target;
    const gap = Math.abs(t.value - t.target);
    out.push(meets ? { kind: 'good', area: areaOf(t.label), text: `${t.label} ${fmtUnit(t.value, t.unit)} meets the ${fmtUnit(t.target, t.unit)} target`, weight: 12 } : { kind: 'attention', area: areaOf(t.label), text: `${t.label} ${fmtUnit(t.value, t.unit)} is ${lower ? 'above' : 'below'} the ${fmtUnit(t.target, t.unit)} target by ${t.unit === 'pct' ? `${round1(gap)} pts` : fmtUnit(gap, t.unit)}`, evidence: `${t.label} ${fmtUnit(t.value, t.unit)}, target ${fmtUnit(t.target, t.unit)}`, weight: 12 });
  }
  return out.slice(0, 2);
}

/** R3 concentration: one category holds at least 40% of a single-series bar chart. */
function concentrationInsights(charts: ReportChart[]): Insight[] {
  const out: Insight[] = [];
  for (const c of charts) {
    if (c.type !== 'bar' || !allows(c, 'concentration')) continue;
    const key = singleSeries(c);
    if (!key || c.data.length < 3 || c.unit === 'pct' || c.unit === 'rating') continue;
    const items = c.data.map((d) => ({ label: String(d[c.x] ?? ''), value: numOf(d[key]) ?? 0 }));
    const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
    if (total < 10) continue;
    const top = [...items].sort((a, b) => b.value - a.value)[0]!;
    const share = Math.round((top.value / total) * 100);
    if (share < 40) continue;
    const kind = /incident|breach|problem|out of scope|out-of-scope/i.test(c.title) ? 'attention' : 'info';
    out.push({ kind, area: areaOf(c.title), text: `${top.label} accounts for ${share}% of ${c.title.toLowerCase()} (${fmtUnit(top.value, c.unit)} of ${fmtUnit(total, c.unit)})`, evidence: c.title, weight: 8 });
  }
  return out.slice(0, 2);
}

/** R4 extremes: the weakest and strongest category of a percentage bar chart. */
function extremesInsights(charts: ReportChart[]): Insight[] {
  const out: Insight[] = [];
  for (const c of charts) {
    if (c.type !== 'bar' || c.unit !== 'pct' || !allows(c, 'extremes')) continue;
    const key = singleSeries(c);
    if (!key || c.data.length < 3) continue;
    const items = c.data.map((d) => ({ label: String(d[c.x] ?? ''), value: numOf(d[key]) })).filter((i): i is { label: string; value: number } => i.value !== null);
    if (items.length < 3) continue;
    const sorted = [...items].sort((a, b) => a.value - b.value);
    const worst = sorted[0]!, best = sorted[sorted.length - 1]!;
    const floor = c.target ?? 90;
    out.push({ kind: worst.value < floor ? 'attention' : 'good', area: areaOf(c.title), text: `${worst.label} is the weakest at ${fmtUnit(worst.value, 'pct')}; ${best.label} the strongest at ${fmtUnit(best.value, 'pct')}`, evidence: c.title, weight: 7 });
  }
  return out.slice(0, 2);
}

/** R5 outliers: a point of a line more than two standard deviations above the period mean. */
function outlierInsights(charts: ReportChart[]): Insight[] {
  for (const c of charts) {
    if (c.type !== 'line' || !allows(c, 'outliers') || c.data.length < 6) continue;
    const key = Array.isArray(c.y) ? c.y[0]! : c.y;
    const points = c.data.map((d) => ({ x: String(d[c.x] ?? ''), v: numOf(d[key]) })).filter((p): p is { x: string; v: number } => p.v !== null);
    if (points.length < 6) continue;
    const mean = points.reduce((s, p) => s + p.v, 0) / points.length;
    const sd = Math.sqrt(points.reduce((s, p) => s + (p.v - mean) ** 2, 0) / points.length);
    if (sd <= 0) continue;
    const spike = [...points].sort((a, b) => b.v - a.v)[0]!;
    if (spike.v <= mean + 2 * sd || mean <= 0) continue;
    const label = c.labels?.[key] ?? key;
    return [{ kind: 'attention', area: areaOf(c.title), text: `${spike.x} had ${fmtUnit(spike.v, c.unit)} ${label.toLowerCase()}, ${round1(spike.v / mean)}× the period average (${fmtUnit(round1(mean), c.unit)})`, evidence: c.title, weight: 6 }];
  }
  return [];
}

/** R6 clean sheet: an exception list (breached, major, failed, low-rated, exhausted, expired) with no rows. */
function cleanSheetInsights(result: ReportResult): Insight[] {
  const out: Insight[] = [];
  for (const s of result.sections ?? []) {
    if (!/breached|major|failed|low-rated|exhausted|expired/i.test(s.title) || s.rows.length) continue;
    out.push({ kind: 'good', area: areaOf(s.title), text: `No ${s.title.toLowerCase()} in the period`, weight: 5 });
  }
  return out.slice(0, 2);
}

export function deriveInsights(result: ReportResult, opts: { reportName?: string; comparison?: string | null } = {}): Insight[] {
  const tiles = result.summary ?? [];
  const charts = [...(result.charts ?? []), ...(result.sections ?? []).flatMap((s) => s.charts ?? [])];
  const all = [...trendInsights(tiles, opts.comparison), ...targetInsights(tiles), ...concentrationInsights(charts), ...extremesInsights(charts), ...outlierInsights(charts), ...cleanSheetInsights(result)];
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const i of all.sort((a, b) => b.weight - a.weight)) {
    const key = `${i.area}|${i.text.split(' ').slice(0, 3).join(' ').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

/** The pack's recommendations when it has them, otherwise one templated step per attention area, at most five. */
export function deriveNextSteps(insights: Insight[], recommendations?: Recommendation[]): string[] {
  if (recommendations?.length) return recommendations.slice(0, 5).map((r) => r.recommendation);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const i of insights) {
    if (i.kind !== 'attention' || seen.has(i.area)) continue;
    seen.add(i.area);
    out.push(NEXT_STEP_BY_AREA[i.area] ?? `Discuss ${i.area.toLowerCase()} at the next service review`);
    if (out.length >= 5) break;
  }
  return out;
}

/** The rules' narrative: a one-line summary from the headline tiles and the three lists. */
export function buildNarrative(result: ReportResult): Narrative {
  const insights = result.insights ?? deriveInsights(result, { comparison: result.comparison?.label });
  const tiles = (result.summary ?? []).filter((t) => t.value !== null && t.value !== undefined && t.value !== '').slice(0, 2);
  const comparison = result.comparison?.label;
  const sentences = tiles.map((t) => {
    const d = t.delta;
    const clause = d && isNum(d.change) && isNum(d.previous) ? ` (${d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'unchanged'}${d.change !== 0 ? ` ${fmtDelta({ ...d, unit: d.unit ?? t.unit }).replace(/^[+−±]/, '')}` : ''} from ${comparison ?? 'the previous period'})` : '';
    return `${t.label} was ${fmtTileValue(t)}${clause}`;
  });
  const summary = sentences.length ? `${sentences.join('; ')}.` : `${result.rowCount ?? result.rows.length} row${(result.rowCount ?? result.rows.length) === 1 ? '' : 's'} in the period.`;
  return {
    summary,
    wentWell: insights.filter((i) => i.kind === 'good').slice(0, 4).map((i) => i.text),
    needsAttention: insights.filter((i) => i.kind === 'attention').slice(0, 4).map((i) => i.text),
    nextSteps: deriveNextSteps(insights, result.recommendations),
    source: 'rules',
  };
}

