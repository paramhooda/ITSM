import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { llmJson } from '@/modules/ai/service';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { REVIEW_SYSTEM } from '@/modules/ai/prompt';
import { registerReport, findReport, isCustomerUser, type ReportParams, type ReportResult, type ReportSection, type ReportChart } from '../registry';
import { rows, col, num, customerParam, dateRangeParam, boolParam } from './helpers';

/**
 * The monthly service review for one customer, composed from the single
 * reports: SLA performance, ticket volume, major incidents, entitlement
 * utilisation, assets whose cover expires soon, customer satisfaction and
 * (for staff) out-of-scope work, with a scorecard up front and recommendations drawn from the figures.
 * Chosen as PDF it opens with a cover page; as Excel every part is a sheet.
 */

const EXPIRING_DAYS = 90;

interface Scorecard {
  area: string;
  metric: string;
  value: string | number | null;
  note: string;
  status: 'good' | 'watch' | 'attention';
}

export interface Recommendation {
  area: string;
  recommendation: string;
  evidence: string;
}

const recommendationSchema = z.object({ recommendations: z.array(z.object({ area: z.string().trim().min(1).max(60), recommendation: z.string().trim().min(1).max(400), evidence: z.string().trim().min(1).max(300) })).max(6) });

const summaryValue = (r: ReportResult, label: string) => r.summary?.find((s) => s.label === label)?.value ?? null;
const summaryHint = (r: ReportResult, label: string) => r.summary?.find((s) => s.label === label)?.hint ?? '';
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The CSAT summary tile reads "4.2/5" (or "n/a"); this takes the number back out. */
const csatAverage = (r: ReportResult): number | null => {
  const v = summaryValue(r, 'Average rating');
  if (typeof v === 'number') return v;
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)\/5$/.exec(v) : null;
  return m ? Number(m[1]) : null;
};

/** The fixed rules that always produce recommendations; the model rephrases and prioritises them when it is on. */
export function deterministicRecommendations(card: Scorecard[], parts: { sla: ReportResult; volume: ReportResult; incidents: ReportResult; amc: ReportResult; assets: ReportResult; oos: ReportResult | null; csat?: ReportResult | null }): Recommendation[] {
  const out: Recommendation[] = [];
  const compliance = n(summaryValue(parts.sla, 'Overall compliance'));
  const breaches = n(summaryValue(parts.sla, 'Breaches')) ?? 0;
  if (breaches > 0 || (compliance !== null && compliance < 95)) {
    const worst = [...parts.sla.rows].filter((r) => n(r.compliance_pct) !== null).sort((a, b) => num(a.compliance_pct) - num(b.compliance_pct))[0];
    out.push({ area: 'Service levels', recommendation: `Walk through the ${breaches} breached ticket${breaches === 1 ? '' : 's'} with the service desk lead and agree corrective actions${worst ? ` for ${worst.priority} ${String(worst.metric).toLowerCase()}` : ''}.`, evidence: `Overall compliance ${compliance ?? 'n/a'}%${worst ? `; lowest ${worst.priority} ${String(worst.metric).toLowerCase()} at ${worst.compliance_pct}%` : ''}; ${summaryHint(parts.sla, 'Overall compliance')}.` });
  }
  const major = parts.incidents.rows.length;
  if (major > 0) {
    const open = parts.incidents.rows.filter((r) => !r.resolved_at).length;
    out.push({ area: 'Major incidents', recommendation: `Share the post-incident review${major === 1 ? '' : 's'} for the ${major} major incident${major === 1 ? '' : 's'} and confirm every follow-up action has an owner and a date.`, evidence: `${major} major incident${major === 1 ? '' : 's'} in the period${open ? `, ${open} still open` : ''}; MTTR ${summaryValue(parts.incidents, 'MTTR (min)') ?? 'n/a'} min.` });
  }
  const exhausted = parts.amc.rows.filter((r) => r.status === 'exhausted');
  const warning = parts.amc.rows.filter((r) => r.status === 'warning');
  if (exhausted.length || warning.length) {
    const first = (exhausted[0] ?? warning[0])!;
    out.push({ area: 'Entitlements', recommendation: `${exhausted.length ? `Top up or renew ${exhausted.length} exhausted entitlement${exhausted.length === 1 ? '' : 's'}` : `Review ${warning.length} entitlement${warning.length === 1 ? '' : 's'} past the warning threshold`} before the next review (first: ${first.entitlement}, contract ${first.contract}).`, evidence: `${first.entitlement}: ${first.used} of ${first.quantity} ${first.unit} used (${first.pct}%); ${exhausted.length} exhausted, ${warning.length} over threshold.` });
  }
  const expiring = parts.assets.rows.length;
  if (expiring > 0) {
    const first = parts.assets.rows[0]!;
    const soonest = [...parts.assets.rows].map((r) => [r.warranty_end, r.amc_end].filter(Boolean).map(String).sort()[0]).filter(Boolean).sort()[0];
    out.push({ area: 'Asset cover', recommendation: `Renew warranty or AMC cover on ${expiring} asset${expiring === 1 ? '' : 's'} whose cover ends within ${EXPIRING_DAYS} days or has lapsed (first: ${first.tag ?? first.name}).`, evidence: `${expiring} asset${expiring === 1 ? '' : 's'} with expiring or expired cover${soonest ? `; earliest end ${String(soonest).slice(0, 10)}` : ''}.` });
  }
  if (parts.oos && parts.oos.rows.length) {
    const hours = n(summaryValue(parts.oos, 'Time spent (h)')) ?? 0;
    out.push({ area: 'Scope', recommendation: `Discuss the ${parts.oos.rows.length} out-of-scope request${parts.oos.rows.length === 1 ? '' : 's'} and whether the contract scope should be extended or the work quoted separately.`, evidence: `${parts.oos.rows.length} out-of-scope ticket${parts.oos.rows.length === 1 ? '' : 's'}, ${hours} h of engineering time.` });
  }
  if (parts.csat) {
    const csatAvg = csatAverage(parts.csat);
    const csatLow = n(summaryValue(parts.csat, 'Low ratings')) ?? 0;
    const csatResponses = n(summaryValue(parts.csat, 'Responses')) ?? 0;
    if (csatLow > 0 || (csatAvg !== null && csatAvg < 4)) {
      out.push({ area: 'Satisfaction', recommendation: `Call the ${csatLow} customer contact${csatLow === 1 ? '' : 's'} who rated a ticket 2 or below, agree what went wrong and feed it into the next service review.`, evidence: `Average rating ${csatAvg ?? 'n/a'}/5 from ${csatResponses} response${csatResponses === 1 ? '' : 's'}; ${csatLow} low rating${csatLow === 1 ? '' : 's'}.` });
    }
  }
  const opened = n(summaryValue(parts.volume, 'Opened')) ?? 0;
  const resolved = n(summaryValue(parts.volume, 'Resolved')) ?? 0;
  if (opened - resolved >= 5) out.push({ area: 'Backlog', recommendation: `Agree a backlog reduction plan: ${opened - resolved} more tickets were opened than resolved in the period.`, evidence: `${opened} opened, ${resolved} resolved.` });
  if (!out.length) out.push({ area: 'Service', recommendation: 'The service ran within its targets this period; keep the standing review cadence and revisit the entitlement and cover positions next month.', evidence: `${card.filter((c) => c.status === 'good').length} of ${card.length} scorecard lines on target.` });
  return out.slice(0, 6);
}

async function aiRecommendations(ctx: Ctx, customer: string, period: { from: string; to: string }, card: Scorecard[], fallback: Recommendation[]): Promise<Recommendation[]> {
  try {
    const settings = await loadAiSettings(ctx.tx);
    if (!featureEnabled(settings, 'recommendations')) return fallback;
  } catch {
    return fallback;
  }
  const llm = await llmJson(REVIEW_SYSTEM, JSON.stringify({ customer, period, scorecard: card.map((c) => ({ area: c.area, metric: c.metric, value: c.value, note: c.note, status: c.status })), findings: fallback }), (v) => recommendationSchema.parse(v), { maxTokens: 900 });
  return llm?.data.recommendations.length ? llm.data.recommendations : fallback;
}

registerReport({
  key: 'service_review_pack',
  name: 'Service review pack',
  description: 'The monthly service review for one customer: scorecard, SLA performance, ticket volume, major incidents, entitlement utilisation, expiring asset cover, out-of-scope work and recommendations, ready to send as PDF or Excel.',
  category: 'customers',
  permissions: ['reports:run', 'contracts:read', 'assets:read'],
  portal: true,
  cover: true,
  parameters: [{ ...customerParam, required: true, help: 'The pack covers one organisation' }, dateRangeParam, { key: 'recommendations', label: 'Include recommendations', type: 'boolean', default: true }],
  defaultDateRange: 'last_month',
  async run(ctx, p): Promise<ReportResult> {
    if (!p.customerId) throw new ValidationError('Choose a customer: the service review pack covers one organisation');
    const part = (key: string, overrides: Record<string, unknown> = {}) => {
      const def = findReport(key);
      if (!def) throw new Error(`Report ${key} is not registered`);
      return def.run(ctx, { ...p, ...overrides } as ReportParams);
    };
    // one client per transaction: the parts run one after another
    const sla = await part('sla_performance', { ticketType: '' });
    const volume = await part('ticket_volume', { granularity: 'week' });
    const incidents = await part('incident_report', { majorOnly: true });
    const amc = await part('amc_utilization', { includeInactive: false });
    const assets = await part('asset_register', { expiringOnly: true, expiringDays: EXPIRING_DAYS });
    const oos = isCustomerUser(ctx) ? null : await part('out_of_scope_activity', { includeUnknown: false });
    // Customer satisfaction needs surveys:read for staff (the pack itself does not), so the part is skipped, not refused, for roles without it.
    const csat = isCustomerUser(ctx) || ctx.can('surveys:read', p.customerId) ? await part('csat_summary', { groupBy: 'service' }) : null;
    const [customerRow] = await rows<{ name: string }>(ctx, sql`SELECT name FROM customers WHERE id = ${p.customerId}::uuid`);
    const customer = customerRow?.name ?? 'Customer';

    const compliance = n(summaryValue(sla, 'Overall compliance'));
    const resolution = n(summaryValue(sla, 'Resolution compliance'));
    const response = n(summaryValue(sla, 'Response compliance'));
    const breaches = n(summaryValue(sla, 'Breaches')) ?? 0;
    const opened = n(summaryValue(volume, 'Opened')) ?? 0;
    const resolved = n(summaryValue(volume, 'Resolved')) ?? 0;
    const mttr = n(summaryValue(incidents, 'MTTR (min)'));
    const exhausted = amc.rows.filter((r) => r.status === 'exhausted').length;
    const warning = amc.rows.filter((r) => r.status === 'warning').length;
    const oosHours = oos ? n(summaryValue(oos, 'Time spent (h)')) ?? 0 : 0;
    const csatAvg = csat ? csatAverage(csat) : null;
    const csatResponses = csat ? n(summaryValue(csat, 'Responses')) ?? 0 : 0;
    const csatSatisfied = csat && typeof summaryValue(csat, 'Satisfied') === 'string' ? String(summaryValue(csat, 'Satisfied')) : 'n/a';
    const pctStatus = (v: number | null, good = 95, watch = 90): Scorecard['status'] => (v === null ? 'good' : v >= good ? 'good' : v >= watch ? 'watch' : 'attention');
    const card: Scorecard[] = [
      { area: 'Service levels', metric: 'Overall SLA compliance', value: compliance === null ? 'n/a' : `${compliance}%`, note: summaryHint(sla, 'Overall compliance'), status: pctStatus(compliance) },
      { area: 'Service levels', metric: 'Resolution compliance', value: resolution === null ? 'n/a' : `${resolution}%`, note: '', status: pctStatus(resolution) },
      { area: 'Service levels', metric: 'Response compliance', value: response === null ? 'n/a' : `${response}%`, note: '', status: pctStatus(response) },
      { area: 'Service levels', metric: 'SLA breaches', value: breaches, note: `${summaryValue(sla, 'Breached tickets') ?? 0} tickets`, status: breaches === 0 ? 'good' : breaches <= 3 ? 'watch' : 'attention' },
      { area: 'Volume', metric: 'Tickets opened', value: opened, note: summaryHint(volume, 'Opened'), status: 'good' },
      { area: 'Volume', metric: 'Tickets resolved', value: resolved, note: opened > resolved ? `${opened - resolved} more opened than resolved` : 'keeping pace', status: opened - resolved >= 5 ? 'watch' : 'good' },
      { area: 'Incidents', metric: 'Major incidents', value: incidents.rows.length, note: mttr === null ? '' : `MTTR ${mttr} min`, status: incidents.rows.length === 0 ? 'good' : 'attention' },
      ...(csat ? [{ area: 'Satisfaction', metric: 'Customer satisfaction', value: csatAvg === null ? 'n/a' : `${csatAvg}/5`, note: `${csatResponses} response${csatResponses === 1 ? '' : 's'}, ${csatSatisfied === 'n/a' ? '0%' : csatSatisfied} satisfied`, status: (csatAvg === null ? 'good' : csatAvg >= 4 ? 'good' : csatAvg >= 3.5 ? 'watch' : 'attention') as Scorecard['status'] }] : []),
      { area: 'Entitlements', metric: 'Entitlements over threshold', value: warning + exhausted, note: `${exhausted} exhausted`, status: exhausted ? 'attention' : warning ? 'watch' : 'good' },
      { area: 'Assets', metric: `Cover expiring within ${EXPIRING_DAYS} days or lapsed`, value: assets.rows.length, note: `${assets.rows.filter((r) => r.warranty_status === 'expired' || r.amc_status === 'expired').length} already lapsed`, status: assets.rows.length === 0 ? 'good' : 'watch' },
      ...(oos ? [{ area: 'Scope', metric: 'Out-of-scope requests', value: oos.rows.length, note: `${oosHours} h of engineering time`, status: (oos.rows.length === 0 ? 'good' : oos.rows.length <= 2 ? 'watch' : 'attention') as Scorecard['status'] }] : []),
    ];

    const wantRecommendations = boolParam(p, 'recommendations', true);
    const fallback = deterministicRecommendations(card, { sla, volume, incidents, amc, assets, oos, csat });
    const recommendations = wantRecommendations ? await aiRecommendations(ctx, customer, { from: p.from, to: p.to }, card, fallback) : [];

    // the customer column goes (the pack is about one organisation) along with columns that add little on paper
    const drop = (cols: ReportSection['columns'], keys: string[]) => cols.filter((c) => !keys.includes(c.key) && c.key !== 'customer');
    const sections: ReportSection[] = [
      ...(recommendations.length ? [{ title: 'Recommendations', columns: [col('area', 'Area'), col('recommendation', 'Recommendation'), col('evidence', 'Evidence')], rows: recommendations.map((r) => ({ ...r })) }] : []),
      { title: 'SLA by priority and metric', columns: sla.columns, rows: sla.rows },
      ...(sla.sections ?? []).map((s) => ({ ...s, columns: drop(s.columns, []) })),
      { title: 'Ticket volume by week', columns: volume.columns, rows: volume.rows },
      { title: 'Major incidents', columns: drop(incidents.columns, ['is_major', 'site', 'response_minutes']), rows: incidents.rows },
      { title: 'Entitlement utilisation', columns: drop(amc.columns, ['period_start', 'period_end']), rows: amc.rows },
      { title: 'Expiring asset cover', columns: drop(assets.columns, ['manufacturer', 'lifecycle_stage', 'eol_date', 'ci']), rows: assets.rows },
      ...(oos ? [{ title: 'Out-of-scope work', columns: drop(oos.columns, ['scope_status', 'contract', 'visits']), rows: oos.rows }] : []),
      ...(csat ? [{ title: 'Customer satisfaction by service', columns: csat.columns, rows: csat.rows }] : []),
      ...(csat?.sections ?? []).filter((x) => x.title === 'Lowest-rated tickets').map((x) => ({ ...x, columns: drop(x.columns, []) })),
    ];
    const csatTrend = (csat?.charts ?? []).filter((c) => c.title === 'Average rating per week');
    const charts: ReportChart[] = [...(volume.charts ?? []).slice(0, 1), ...(sla.charts ?? []).slice(0, 1), ...(incidents.rows.length ? (incidents.charts ?? []).slice(0, 1) : []), ...(amc.rows.length ? (amc.charts ?? []).slice(0, 1) : []), ...csatTrend].filter((c) => c.data.length);
    return {
      columns: [col('area', 'Area'), col('metric', 'Measure'), col('value', 'Value'), col('status', 'Status'), col('note', 'Note')],
      rows: card.map((c) => ({ ...c, status: c.status === 'good' ? 'On target' : c.status === 'watch' ? 'Watch' : 'Needs attention' })),
      summary: [
        { label: 'SLA compliance', value: compliance === null ? 'n/a' : `${compliance}%`, hint: `${breaches} breach${breaches === 1 ? '' : 'es'}` },
        { label: 'Tickets opened', value: opened },
        { label: 'Tickets resolved', value: resolved },
        { label: 'Major incidents', value: incidents.rows.length },
        { label: 'Entitlement alerts', value: warning + exhausted, hint: `${exhausted} exhausted` },
        { label: 'Cover expiring', value: assets.rows.length, hint: `within ${EXPIRING_DAYS} days` },
        ...(oos ? [{ label: 'Out of scope', value: oos.rows.length, hint: `${oosHours} h` }] : []),
        ...(csat ? [{ label: 'Customer satisfaction', value: csatAvg === null ? 'n/a' : `${csatAvg}/5`, hint: `${csatResponses} response${csatResponses === 1 ? '' : 's'}` }] : []),
        { label: 'Recommendations', value: recommendations.length },
      ],
      charts,
      sections,
    };
  },
});
