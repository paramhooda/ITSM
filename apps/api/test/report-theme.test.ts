/**
 * The report document theme (pure, no database): the SVG charts, the
 * deterministic insight rules, the previous-period deltas, the narrative
 * grounding filter and the HTML document.
 *   npx vitest run test/report-theme.test.ts
 */
import { describe, it, expect } from 'vitest';
import { renderChart, barChart, donutChart, heatmap, gauge, sparkline, niceTicks, fmtUnit } from '../src/modules/reports/theme/charts';
import { renderDocument, cssString, sectionId } from '../src/modules/reports/theme/document';
import { deriveInsights, buildNarrative, deriveNextSteps, DEFAULT_GLOSSARY, groundedAgainst, numbersIn, fmtDelta, fmtTileValue } from '../src/modules/reports/insights';
import { attachDeltas, previousRange, LOWER_IS_BETTER, inferUnit } from '../src/modules/reports/analytics';
import { CATEGORICAL, DEEMPHASIS, SEQUENTIAL, STATUS } from '../src/modules/reports/theme/tokens';
import { LOGO_PNG_DATA_URI, GEIST_WOFF2_DATA_URI } from '../src/modules/reports/theme/assets';
import { renderHtml, svgChart, brandColor } from '../src/modules/reports/render';
import type { ReportChart, ReportResult } from '../src/modules/reports/registry';

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const attrs = (s: string, re: RegExp) => [...s.matchAll(re)].map((m) => m[1]!);
const bar = (data: Record<string, unknown>[], extra: Partial<ReportChart> = {}): ReportChart => ({ type: 'bar', title: 'Incidents by category', data, x: 'label', y: 'count', ...extra });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

describe('charts', () => {
  it('bar: thin rounded columns in the first categorical hue with direct labels, emphasis grays the rest', () => {
    const svg = renderChart(bar([{ label: 'Network', count: 23 }, { label: 'Server', count: 14 }, { label: 'Wifi', count: 13 }]));
    expect(count(svg, /class="bar"/g)).toBe(3);
    expect(count(svg, /rx="3"/g)).toBe(3);
    const bars = [...svg.matchAll(/<rect class="bar"[^>]*width="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"/g)];
    expect(bars.every((m) => Number(m[1]) <= 24)).toBe(true);
    expect(bars.every((m) => m[2] === CATEGORICAL[0])).toBe(true);
    for (const v of ['>23<', '>14<', '>13<']) expect(svg).toContain(v);
    const emphasised = renderChart(bar([{ label: 'Network', count: 23 }, { label: 'Server', count: 14 }, { label: 'Wifi', count: 13 }], { emphasis: 'Server' }));
    const fills = attrs(emphasised, /<rect class="bar"[^>]*fill="(#[0-9a-f]{6})"/g);
    expect(fills).toEqual([DEEMPHASIS, CATEGORICAL[0], DEEMPHASIS]);
  });

  it('bar: long labels or more than eight bars switch to horizontal bars with labels on the left', () => {
    const svg = renderChart(bar(Array.from({ length: 11 }, (_, i) => ({ label: `A very long category label ${i}`, count: i + 1 }))));
    expect(svg).toContain('class="chart half horizontal"');
    const heights = attrs(svg, /<rect class="bar"[^>]*height="([\d.]+)"/g).map(Number);
    expect(heights.length).toBe(11);
    expect(heights.every((h) => h <= 24)).toBe(true);
    expect(count(svg, /text-anchor="end"[^>]*>A very long/g)).toBe(11);
  });

  it('bar: four series get a legend in the first four slots; more are folded into Other without a fifth hue', () => {
    const four = renderChart(bar([{ label: 'A', s1: 1, s2: 2, s3: 3, s4: 4 }, { label: 'B', s1: 2, s2: 2, s3: 2, s4: 2 }], { y: ['s1', 's2', 's3', 's4'] }));
    expect(attrs(four, /<i style="background:(#[0-9a-f]{6})"/g)).toEqual([CATEGORICAL[0], CATEGORICAL[1], CATEGORICAL[2], CATEGORICAL[3]]);
    const six = renderChart(bar([{ label: 'A', s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, s6: 6 }], { y: ['s1', 's2', 's3', 's4', 's5', 's6'] }));
    expect(six).toContain('Other');
    expect(six).not.toContain(CATEGORICAL[4]);
    expect(count(six, /<i style="background:/g)).toBe(5);
    expect(six).toContain('>11<');
  });

  it('stacked bar: one separated segment per category and series, a total on the cap, status colours for met and breached', () => {
    const svg = renderChart({ type: 'stacked_bar', title: 'Met vs breached by metric', data: [{ label: 'Response', met: 40, breached: 3 }, { label: 'Resolution', met: 30, breached: 5 }], x: 'label', y: ['met', 'breached'], labels: { met: 'Met', breached: 'Breached' }, statusSeries: true });
    const segs = [...svg.matchAll(/<rect class="seg" x="([\d.]+)" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill="(#[0-9a-f]{6})"/g)];
    expect(segs.length).toBe(4);
    const byX = new Map<string, number[]>();
    for (const m of segs) byX.set(m[1]!, [...(byX.get(m[1]!) ?? []), Number(m[2])]);
    for (const ys of byX.values()) expect(Math.abs(ys[0]! - ys[1]!)).toBeGreaterThanOrEqual(2);
    expect(count(svg, /class="total"/g)).toBe(2);
    expect(svg).toContain('>43<');
    expect(segs.map((m) => m[4])).toEqual([STATUS.good, STATUS.critical, STATUS.good, STATUS.critical]);
    expect(svg).toContain('class="legend"');
  });

  it('line: a 2 px line with an end dot in a white ring, no dots on long series, at most eight x labels, a legend only for two series', () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, opened: 5 + (i % 4) }));
    const svg = renderChart({ type: 'line', title: 'Opened per day', data, x: 'day', y: 'opened' });
    expect(count(svg, /<polyline/g)).toBe(1);
    expect(svg).toContain('stroke-width="2" stroke-linejoin="round"');
    expect(count(svg, /<circle class="end"[^>]*stroke="#fff" stroke-width="2"/g)).toBe(1);
    expect(count(svg, /<circle /g)).toBe(1);
    expect(count(svg, /<text[^>]*>2026-09-/g)).toBeLessThanOrEqual(8);
    expect(svg).not.toContain('class="legend"');
    const two = renderChart({ type: 'line', title: 'Opened vs resolved', data: data.map((d) => ({ ...d, resolved: 4 })), x: 'day', y: ['opened', 'resolved'] });
    expect(two).toContain('class="legend"');
    expect(count(two, /<polyline/g)).toBe(2);
  });

  it('donut: at most six slices plus Other with the total in the centre; close values fall back to a horizontal bar', () => {
    const svg = renderChart({ type: 'donut', title: 'Ticket mix', data: Array.from({ length: 8 }, (_, i) => ({ label: `Slice ${i}`, count: 100 - i * 11 })), x: 'label', y: 'count' });
    expect(count(svg, /class="slice"/g)).toBe(7);
    expect(svg).toContain('Other');
    expect(/class="centre"[^>]*>([^<]+)</.exec(svg)?.[1]).toBe('492');
    const close = donutChart({ type: 'donut', title: 'Close', data: [{ label: 'A', count: 50 }, { label: 'B', count: 47 }, { label: 'C', count: 3 }], x: 'label', y: 'count' });
    expect(close).toContain('horizontal');
    expect(close).not.toContain('class="slice"');
  });

  it('heatmap: every cell present, zero cells on the surface, the maximum in the darkest step, labels only from one upwards; ticks are clean', () => {
    const data = WEEKDAYS.flatMap((row) => HOURS.map((col, h) => ({ row, col, value: row === 'Sun' ? 0 : h >= 9 && h <= 17 ? h - 8 : 0 })));
    const svg = heatmap({ type: 'heatmap', title: 'Arrivals', data, x: 'col', y: 'value', rows: WEEKDAYS, cols: HOURS });
    expect(count(svg, /class="cell"/g)).toBe(168);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain(`fill="${SEQUENTIAL[5]}"`);
    const labelled = data.filter((d) => d.value >= 1).length;
    expect(count(svg, /<text x="[\d.]+" y="[\d.]+" font-size="7.5"/g)).toBe(labelled);
    for (const max of [1234, 3, 0.5, 97, 100000]) {
      const ticks = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      const step = ticks[1]! - ticks[0]!;
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5]).toContain(Math.round(mantissa * 1000) / 1000);
    }
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  it('gauge: the fill follows the distance from the target and the value is printed once', () => {
    const g = (value: number) => gauge({ type: 'gauge', title: 'Overall SLA compliance', data: [{ label: 'Overall', value }], x: 'label', y: 'value', unit: 'pct', target: 95 });
    const fillOf = (svg: string) => /class="fill"[^>]*fill="(#[0-9a-f]{6})"/.exec(svg)?.[1];
    expect(fillOf(g(96.4))).toBe(STATUS.good);
    expect(fillOf(g(91))).toBe(STATUS.warning);
    expect(fillOf(g(80))).toBe(STATUS.critical);
    expect(count(g(96.4), /96\.4%/g)).toBe(1);
    expect(g(96.4)).toContain('target 95%');
  });

  it('sparkline, units and the svgChart compatibility wrapper', () => {
    const spark = sparkline([3, 4, null, 6, 5, 8, 7, 9, 10, 8, 11, 12]);
    expect(spark).toContain(`stroke="${DEEMPHASIS}"`);
    expect(spark).toContain(`fill="${CATEGORICAL[0]}"`);
    expect(sparkline([1])).toBe('');
    expect(fmtUnit(96.4, 'pct')).toBe('96.4%');
    expect(fmtUnit(42, 'minutes')).toBe('42 min');
    expect(fmtUnit(4.2, 'rating')).toBe('4.2/5');
    expect(fmtUnit(7.5, 'hours')).toBe('7.5 h');
    expect(fmtUnit(1234)).toBe('1,234');
    const chart = bar([{ label: 'Network', count: 23 }, { label: 'Server', count: 14 }, { label: 'Wifi', count: 13 }]);
    expect(svgChart(chart)).toBe(renderChart(chart));
    expect(svgChart(chart, 640, 240)).toBe(renderChart(chart, { width: 640, height: 240 }));
    expect(barChart(chart)).toBe(renderChart(chart));
    expect(renderChart({ ...chart, data: [] })).toContain('No data');
  });
});

// ---------------------------------------------------------------- insights and deltas

const fixture = (): ReportResult => ({
  columns: [{ key: 'a', label: 'A' }],
  rows: [{ a: 1 }],
  summary: [
    { label: 'Overall compliance', value: 96.4, unit: 'pct', target: 95, delta: { previous: 92.1, change: 4.3, deltaPct: 4.7, lowerIsBetter: false, unit: 'pct' } },
    { label: 'Breaches', value: 3, unit: 'count', delta: { previous: 9, change: -6, deltaPct: -66.7, lowerIsBetter: true, unit: 'count' } },
    { label: 'Opened', value: 118, unit: 'count', delta: { previous: 110, change: 8, deltaPct: 7.3, lowerIsBetter: false, unit: 'count' } },
  ],
  charts: [
    { type: 'bar', title: 'Incidents by category', data: [{ label: 'Network', count: 23 }, { label: 'Server', count: 14 }, { label: 'Wifi', count: 13 }], x: 'label', y: 'count' },
    { type: 'bar', title: 'Compliance % by priority', data: [{ label: 'P1', compliance: 80 }, { label: 'P2', compliance: 96 }, { label: 'P3', compliance: 100 }], x: 'label', y: 'compliance', unit: 'pct', target: 95 },
    { type: 'line', title: 'Opened per day', data: Array.from({ length: 10 }, (_, i) => ({ day: `D${i + 1}`, opened: i === 6 ? 30 : 5 })), x: 'day', y: 'opened', labels: { opened: 'Opened' } },
  ],
  sections: [{ title: 'Breached tickets', columns: [{ key: 'n', label: 'N' }], rows: [] }],
  comparison: { from: '2026-08-01', to: '2026-08-31', label: '2026-08' },
});

describe('insights', () => {
  it('derives trends, targets, concentration, extremes, outliers and clean sheets from the figures', () => {
    const insights = deriveInsights(fixture(), { reportName: 'Test', comparison: '2026-08' });
    expect(insights.length).toBeLessThanOrEqual(8);
    const texts = insights.map((i) => i.text);
    const find = (re: RegExp) => insights.find((i) => re.test(i.text));
    expect(find(/Overall compliance moved from 92\.1% to 96\.4% \(\+4\.3 pts\) against 2026-08/)?.kind).toBe('good');
    expect(find(/Breaches moved from 9 to 3/)?.kind).toBe('good');
    expect(texts.some((t) => t.startsWith('Opened moved'))).toBe(false);
    expect(find(/Overall compliance 96\.4% meets the 95% target/)?.kind).toBe('good');
    expect(find(/Network accounts for 46% of incidents by category \(23 of 50\)/)?.kind).toBe('attention');
    expect(find(/P1 is the weakest at 80%; P3 the strongest at 100%/)?.kind).toBe('attention');
    expect(find(/D7 had 30 opened, 4× the period average/)?.kind).toBe('attention');
    expect(find(/No breached tickets in the period/)?.kind).toBe('good');
    const narrative = buildNarrative({ ...fixture(), insights });
    expect(narrative.source).toBe('rules');
    expect(narrative.summary).toContain('Overall compliance was 96.4% (up 4.3 pts from 2026-08)');
    expect(narrative.wentWell.length).toBeGreaterThanOrEqual(2);
    expect(narrative.wentWell.length).toBeLessThanOrEqual(4);
    expect(narrative.needsAttention.length).toBeGreaterThanOrEqual(2);
    expect(narrative.nextSteps.length).toBeGreaterThanOrEqual(1);
    expect(narrative.nextSteps.length).toBeLessThanOrEqual(5);
    expect(deriveNextSteps(insights, [{ area: 'X', recommendation: 'Do the thing', evidence: 'e' }])).toEqual(['Do the thing']);
    expect(DEFAULT_GLOSSARY.map((g) => g.term)).toContain('First-contact resolution');
  });

  it('knows which tiles improve when they fall and which unit a label carries', () => {
    for (const l of ['SLA breached', 'Reopen rate', 'MTTR (min)', 'Average age (h)', 'Major incidents', 'Backlog', 'Out of scope']) expect(LOWER_IS_BETTER.test(l), l).toBe(true);
    for (const l of ['Resolved', 'Average rating', 'Average utilization', 'Overall compliance', 'Opened', 'Response rate']) expect(LOWER_IS_BETTER.test(l), l).toBe(false);
    expect(inferUnit('Overall compliance')).toBe('pct');
    expect(inferUnit('MTTR (min)')).toBe('minutes');
    expect(inferUnit('Average rating')).toBe('rating');
    expect(inferUnit('Opened')).toBe('count');
    expect(inferUnit('Time spent (h)')).toBe('hours');
    expect(fmtDelta({ previous: 92.1, change: 4.3, deltaPct: 4.7, unit: 'pct' })).toBe('+4.3 pts');
    expect(fmtDelta({ previous: 100, change: 12, deltaPct: 12, unit: 'count' })).toBe('+12%');
    expect(fmtDelta({ previous: 0, change: 3, deltaPct: null, unit: 'count' })).toBe('+3');
    expect(fmtDelta(undefined)).toBe('—');
    expect(fmtTileValue({ value: 96.4, unit: 'pct' })).toBe('96.4%');
    expect(fmtTileValue({ value: 'n/a' })).toBe('n/a');
  });

  it('previousRange and attachDeltas: the same number of days before, or the whole previous month', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30', preset: 'custom', label: 'x' })).toMatchObject({ from: '2026-08-02', to: '2026-08-31' });
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30', preset: 'last_month', label: 'x' })).toMatchObject({ from: '2026-08-01', to: '2026-08-31', label: '2026-08' });
    expect(previousRange({ from: '2026-09-24', to: '2026-09-30', preset: 'last_7_days', label: 'x' })).toMatchObject({ from: '2026-09-17', to: '2026-09-23' });
    const current: ReportResult = { columns: [], rows: [], summary: [{ label: 'Overall compliance', value: 96.4 }, { label: 'MTTR (min)', value: 42 }, { label: 'Average rating', value: 4.2 }, { label: 'Opened', value: 118 }, { label: 'Breaches', value: 3 }, { label: 'Satisfied', value: 'n/a' }, { label: 'Score', value: '3/5' }, { label: 'New', value: 5 }] };
    const previous: ReportResult = { columns: [], rows: [], summary: [{ label: 'Overall compliance', value: 92.1 }, { label: 'MTTR (min)', value: 42 }, { label: 'Average rating', value: 4.0 }, { label: 'Opened', value: 110 }, { label: 'Breaches', value: 0 }, { label: 'Satisfied', value: 80 }, { label: 'Score', value: 2 }] };
    attachDeltas(current, previous);
    const t = (label: string) => current.summary!.find((x) => x.label === label)!;
    expect(t('Overall compliance')).toMatchObject({ unit: 'pct', delta: { previous: 92.1, change: 4.3, lowerIsBetter: false, unit: 'pct' } });
    expect(t('MTTR (min)')).toMatchObject({ unit: 'minutes', delta: { previous: 42, change: 0, deltaPct: 0, lowerIsBetter: true } });
    expect(t('Average rating').unit).toBe('rating');
    expect(t('Opened')).toMatchObject({ unit: 'count', delta: { previous: 110, change: 8, deltaPct: 7.3 } });
    expect(t('Breaches').delta).toMatchObject({ previous: 0, change: 3, deltaPct: null, lowerIsBetter: true });
    expect(t('Satisfied').delta).toBeUndefined();
    expect(t('Score').delta).toBeUndefined();
    expect(t('New').delta).toBeUndefined();
  });

  it('narrative grounding: every number in a sentence must come from the figures', () => {
    expect(groundedAgainst('Compliance rose to 96.4% from 92.1%', new Set(['96.4', '92.1']))).toBe(true);
    expect(groundedAgainst('Compliance rose to 97% from 92.1%', new Set(['96.4', '92.1']))).toBe(false);
    expect(groundedAgainst('Nothing to flag', new Set())).toBe(true);
    const allowed = numbersIn({ kpis: [{ label: 'Opened', value: 1234 }, { period: '2026-09-01' }], text: '96.40%' });
    expect(allowed.has('1234')).toBe(true);
    expect(allowed.has('96.4')).toBe(true);
    expect(allowed.has('2026')).toBe(true);
    expect(groundedAgainst('1,234 tickets were opened', allowed)).toBe(true);
  });
});

// ---------------------------------------------------------------- the document

const docFixture = (): ReportResult => ({
  columns: [{ key: 'metric', label: 'Measure' }, { key: 'value', label: 'Value', type: 'number', total: 'sum' }],
  rows: [{ metric: 'A', value: 1 }, { metric: 'B', value: 2 }],
  summary: [{ label: 'Overall compliance', value: 96.4, unit: 'pct', target: 95, delta: { previous: 92.1, change: 4.3, deltaPct: 4.7, lowerIsBetter: false, unit: 'pct' }, spark: [90, 92, 94, 96.4] }, { label: 'Opened', value: 118 }],
  charts: [{ type: 'bar', title: 'Incidents by category', data: [{ label: 'Network', count: 23 }, { label: 'Server', count: 14 }], x: 'label', y: 'count' }],
  sections: [
    { title: 'Ticket volume by week', group: 'Demand and workload', intro: 'By week.', columns: [{ key: 'week', label: 'Week' }, { key: 'opened', label: 'Opened', type: 'number', total: 'sum' }], rows: [{ week: 'W1', opened: 10 }, { week: 'W2', opened: 12 }, { week: 'W3', opened: 14 }], totals: true, printLimit: 2 },
    { title: 'By site', group: 'Demand and workload', columns: [{ key: 'site', label: 'Site' }], rows: [{ site: 'Pune' }] },
    { title: 'Major incidents', columns: [{ key: 'n', label: 'N' }], rows: [], callouts: [{ kind: 'good', area: 'Incidents', text: 'No major incidents in the period', weight: 5 }] },
    { title: 'Failed or backed out', group: 'Changes', columns: [{ key: 'n', label: 'N' }], rows: [] },
    { title: 'Recommendations', columns: [{ key: 'area', label: 'Area' }, { key: 'recommendation', label: 'Recommendation' }], rows: [{ area: 'Service levels', recommendation: 'Review the breached tickets' }] },
  ],
  narrative: { summary: 'Overall compliance was 96.4% (up 4.3 pts on 2026-08).', wentWell: ['Overall compliance 96.4% meets the 95% target'], needsAttention: [], nextSteps: ['Review the breached tickets'], source: 'rules' },
  comparison: { from: '2026-08-01', to: '2026-08-31', label: '2026-08' },
});

const fullMeta = () => ({ reportName: 'Service review pack', description: 'The monthly review.', platformName: 'Progression', customerName: 'Acme "Widgets"\nLtd', customerCode: 'ACME', period: '2026-09 (2026-09-01 to 2026-09-30)', generatedAt: new Date('2026-10-03T14:02:00Z'), generatedBy: 'Ananya Krishnan', parameters: { recommendations: true, customerId: 'x' }, brandColor: '#336699', brandAccent: '#ee3137', cover: true, confidentiality: 'Confidential: prepared for Acme "Widgets" Ltd by Progression. Not for onward distribution.', comparisonLabel: '2026-08', timezone: 'Asia/Kolkata', kind: 'pack' as const, printRows: 50, reportKey: 'service_review_pack', runId: 'run-1' });

describe('document', () => {
  it('prints the cover, the running header and footer, the executive summary, grouped sections, totals and the appendix', () => {
    const html = renderHtml(docFixture(), fullMeta());
    expect(html).toContain('class="cover"');
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('@page :first{margin:0');
    expect(html).toContain('counter(pages)');
    expect(html).toContain('@top-left{content:"Service review pack · Acme \\"Widgets\\" Ltd"');
    expect(html).toContain('@bottom-left{content:"Confidential: prepared for Acme \\"Widgets\\" Ltd by Progression. Not for onward distribution."');
    expect(html).toContain(LOGO_PNG_DATA_URI);
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(style).toContain(`url(${GEIST_WOFF2_DATA_URI})`);
    expect(style).not.toContain('&#x3D;');
    expect(html).toContain('#336699');
    expect(html).toContain('--accent:#ee3137');
    for (const item of ['<li>Executive summary</li>', '<li>Scorecard</li>', '<li>Demand and workload</li>', '<li>Major incidents</li>', '<li>Recommendations</li>', '<li>Appendix</li>']) expect(html).toContain(item);
    expect(count(html, /<h2 id="s-demand-and-workload">/g)).toBe(1);
    expect(html).toContain('<h3 id="s-ticket-volume-by-week">');
    expect(html).toContain('<h3 id="s-by-site">');
    expect(html).toContain('What went well');
    expect(html).toContain('What needs attention');
    expect(html).toContain('Next steps');
    expect(html).toContain('<tfoot><tr><td class="">Total</td><td class="num">36</td></tr></tfoot>');
    expect(html).toContain('nth-child(even)');
    expect(html).toContain('Definitions');
    expect(html).toContain('First-contact resolution');
    expect(html).toContain('Data notes');
    expect(html).toContain('Asia/Kolkata');
    expect(html).toContain('compared with 2026-08');
    expect(html).toContain('Showing the first 2 of 3 rows');
    expect(html).not.toContain('id="s-failed-or-backed-out"');
    expect(html).toContain('Sections with nothing to report: Failed or backed out');
    expect(html).toContain('No major incidents in the period');
    expect(html).toContain('<div class="value">96.4%</div>');
    expect(html).toContain('+4.3 pts');
    expect(html).toContain('class="spark"');
    expect(html).toContain('recommendations: true');
    expect(html).not.toContain('customerId');
    expect(html).toContain('docs-2');
    for (const bad of ['undefined', 'NaN', '[object']) expect(html).not.toContain(bad);
    expect(cssString('x"y\\z\nw')).toBe('x\\"y\\\\z w');
    const long = cssString(`${'word '.repeat(40)}end`);
    expect(long.length).toBeLessThanOrEqual(140);
    // cut at a word boundary: a whole word then the ellipsis, never a fragment
    expect(long).toMatch(/ word…$/);
    expect(cssString('a'.repeat(200))).toHaveLength(140);
    expect(cssString('x</style><img src=x onerror=alert(1)>')).toBe('x\\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e ');
    // a customer name that tries to close the style block stays inside it
    const hostile = renderHtml(docFixture(), { ...fullMeta(), customerName: 'Acme</style><img src=x onerror=alert(1)>' });
    const styleBlock = hostile.slice(hostile.indexOf('<style>'), hostile.indexOf('</style>'));
    expect(styleBlock).toContain('counter(pages)');
    expect(hostile).not.toContain('<img src=x');
    expect(hostile).toContain('Acme&lt;/style&gt;');
    expect(sectionId('Ticket volume by week')).toBe('s-ticket-volume-by-week');
    expect(brandColor('red')).toBe('#292345');
    const custom = renderHtml(docFixture(), { ...fullMeta(), logoUrl: 'https://example.com/logo.png' });
    expect(custom).toContain('src="https://example.com/logo.png"');
    expect(custom).not.toContain(LOGO_PNG_DATA_URI);
  });

  it('renders without a cover, with the minimal meta and for a portal reader', () => {
    const plain = renderHtml(docFixture(), { reportName: 'Plain', platformName: 'P', period: 'x', generatedAt: new Date('2026-10-03T14:02:00Z') });
    expect(plain).not.toContain('class="cover"');
    expect(plain).not.toContain('@page :first');
    expect(plain).toContain('@bottom-left{content:"P internal. Confidential: not for onward distribution."');
    expect(plain).toContain('Detail (2 rows)');
    for (const bad of ['undefined', 'NaN', '[object']) expect(plain).not.toContain(bad);
    const portal = renderDocument({ result: docFixture(), meta: { ...fullMeta(), customerName: 'Pack Customer', portal: true, confidentiality: 'Confidential: prepared for Pack Customer by Progression. Not for onward distribution.' } });
    const footer = /@bottom-left\{content:"([^"]*)"/.exec(portal)?.[1] ?? '';
    expect(footer).toMatch(/prepared for Pack Customer/i);
    expect(footer).not.toMatch(/internal/i);
  });
});
