import { ValidationError } from '@/core/errors';
import { registerReport, findReport, isCustomerUser, type ReportParams, type ReportResult, type ReportSection, type ReportChart, type ReportColumn, type SummaryTile, type Insight } from '../registry';
import { ticketKpis, breakdown, backlogAgeing, responsiveness, changeOutcomes, csatPart, knownErrorsPart, softwarePart, cabPart, runPart, previousRange, attachDeltas, afterHoursShare, scopeTimezone, type TicketKpis, type ChangeOutcomes, type KnownErrorsPart, type SoftwarePart } from '../analytics';
import { addDays } from '../dates';
import { col, num, customerParam, dateRangeParam, boolParam, AGE_ORDER } from './helpers';

/**
 * The monthly service review for one customer, composed from the single
 * reports and the shared analytics: a scorecard up front, then service
 * levels, demand and workload (volume, type and priority mix, the arrival
 * heatmap, top services and categories, sites), responsiveness (MTTA, MTTR,
 * first-contact resolution, reopen rate, backlog ageing, per-engineer
 * resolution for staff), major incidents, problems and known errors, changes
 * with their success rate, customer satisfaction, contracts and entitlements,
 * assets and software, field service and maintenance, out-of-scope work for
 * staff and numbered recommendations drawn from the figures. Every figure
 * that has a previous-period twin carries a delta; the model only rephrases
 * the insights, after the report transaction. Tile labels and section titles
 * are read by name elsewhere: keep them.
 */

const EXPIRING_DAYS = 90;
const SLA_TARGET = 95;
const CSAT_TARGET = 4;
const FCR_TARGET = 70;
const CHANGE_TARGET = 95;
const PM_TARGET = 90;
const TABLE_CAP = 20;
/** Parts composed from other definitions; one that is not registered on this installation is named in the appendix. */
const PART_DEFINITIONS: [key: string, name: string][] = [['preventive_maintenance', 'Preventive maintenance'], ['field_visits', 'Field visits'], ['change_calendar', 'Change calendar'], ['csat_summary', 'Customer satisfaction'], ['known_errors', 'Known errors'], ['licence_compliance', 'Licence compliance'], ['cab_decisions', 'CAB decisions']];
const RATING_MEANING = ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'] as const;

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

/** The parts the recommendation rules read; everything beyond the six original parts is optional (a part the caller may not run is simply absent). */
export interface PackParts {
  sla: ReportResult;
  volume: ReportResult;
  /** Major incidents only (the scorecard counts these rows). */
  incidents: ReportResult;
  amc: ReportResult;
  assets: ReportResult;
  oos: ReportResult | null;
  csat?: ReportResult | null;
  kpis?: TicketKpis;
  previous?: TicketKpis;
  changes?: ChangeOutcomes;
  kedb?: KnownErrorsPart | null;
  software?: SoftwarePart | null;
  afterHoursPct?: number | null;
  pmOnTimePct?: number | null;
}

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
const plural = (count: number, word: string, pluralWord = `${word}s`) => `${count} ${count === 1 ? word : pluralWord}`;

/** The fixed rules that produce the recommendations; the model only rephrases them in the document's narrative, after the report transaction. */
export function deterministicRecommendations(card: Scorecard[], parts: PackParts): Recommendation[] {
  const out: Recommendation[] = [];
  const compliance = n(summaryValue(parts.sla, 'Overall compliance'));
  const breaches = n(summaryValue(parts.sla, 'Breaches')) ?? 0;
  if (breaches > 0 || (compliance !== null && compliance < SLA_TARGET)) {
    const worst = [...parts.sla.rows].filter((r) => n(r.compliance_pct) !== null).sort((a, b) => num(a.compliance_pct) - num(b.compliance_pct))[0];
    out.push({ area: 'Service levels', recommendation: `Walk through the ${plural(breaches, 'breached ticket')} with the service desk lead and agree corrective actions${worst ? ` for ${worst.priority} ${String(worst.metric).toLowerCase()}` : ''}.`, evidence: `Overall compliance ${compliance ?? 'n/a'}%${worst ? `; lowest ${worst.priority} ${String(worst.metric).toLowerCase()} at ${worst.compliance_pct}%` : ''}; ${summaryHint(parts.sla, 'Overall compliance')}.` });
  }
  const major = parts.incidents.rows.length;
  if (major > 0) {
    const open = parts.incidents.rows.filter((r) => !r.resolved_at).length;
    out.push({ area: 'Major incidents', recommendation: `Share the post-incident review${major === 1 ? '' : 's'} for the ${plural(major, 'major incident')} and confirm every follow-up action has an owner and a date.`, evidence: `${plural(major, 'major incident')} in the period${open ? `, ${open} still open` : ''}; MTTR ${summaryValue(parts.incidents, 'MTTR (min)') ?? 'n/a'} min.` });
  }
  const k = parts.kpis;
  if (k && k.reopenPct !== null && k.reopenPct > 10) out.push({ area: 'Responsiveness', recommendation: `Check resolution quality on the ${plural(k.reopened, 'reopened ticket')}: confirm the fix with the requester before resolving.`, evidence: `Reopen rate ${k.reopenPct}% (${k.reopened} of ${k.resolved} resolved tickets reopened).` });
  if (k && k.fcrPct !== null && k.fcrPct < 55 && k.resolved >= 5) out.push({ area: 'Responsiveness', recommendation: 'Raise first-contact resolution: review the tickets that needed a reassignment or an escalation and give the first line the access and the runbooks to close them.', evidence: `First-contact resolution ${k.fcrPct}% (${k.fcr} of ${k.resolved} resolved tickets), target ${FCR_TARGET}%.` });
  let backlogRule = false;
  if (k && k.backlogStart > 0 && k.backlogEnd >= k.backlogStart * 1.2 && k.backlogEnd - k.backlogStart >= 3) {
    backlogRule = true;
    out.push({ area: 'Backlog', recommendation: `Agree a backlog reduction plan: the backlog grew from ${k.backlogStart} to ${k.backlogEnd} open tickets over the period.`, evidence: `${k.opened} opened, ${k.resolved} resolved; ${k.unassignedNow} unassigned now.` });
  }
  if (parts.afterHoursPct !== null && parts.afterHoursPct !== undefined && parts.afterHoursPct >= 35 && (k?.opened ?? 0) >= 10) out.push({ area: 'Demand', recommendation: `Consider extended-hours cover: ${parts.afterHoursPct}% of tickets arrive outside 09:00-18:00 on weekdays.`, evidence: `${parts.afterHoursPct}% of ${k?.opened ?? 0} tickets opened outside business hours or at the weekend.` });
  if (parts.kedb && parts.kedb.total > 0) {
    const unpublished = Math.max(0, parts.kedb.total - parts.kedb.published);
    out.push({ area: 'Problems', recommendation: unpublished > 0 ? `Publish workarounds for the ${plural(unpublished, 'open known error')} not yet on the portal so users can help themselves.` : `Drive the ${plural(parts.kedb.total, 'open known error')} to a permanent fix: ${parts.kedb.fixInProgress} already have a fix in progress.`, evidence: `${plural(parts.kedb.total, 'active known error')}: ${parts.kedb.open} open, ${parts.kedb.fixInProgress} with a fix in progress, ${parts.kedb.published} published, ${parts.kedb.linkedIncidents} linked incidents.` });
  }
  if (parts.changes && parts.changes.successPct !== null && parts.changes.successPct < CHANGE_TARGET) {
    const bad = parts.changes.failed + parts.changes.backedOut;
    out.push({ area: 'Changes', recommendation: `Review the ${plural(bad, 'failed or backed-out change')} at CAB and strengthen test and backout plans.`, evidence: `Change success rate ${parts.changes.successPct}% (${parts.changes.implemented} implemented, ${parts.changes.failed} failed, ${parts.changes.backedOut} backed out), target ${CHANGE_TARGET}%.` });
  }
  if (parts.csat) {
    const csatAvg = csatAverage(parts.csat);
    const csatLow = n(summaryValue(parts.csat, 'Low ratings')) ?? 0;
    const csatResponses = n(summaryValue(parts.csat, 'Responses')) ?? 0;
    if (csatLow > 0 || (csatAvg !== null && csatAvg < CSAT_TARGET)) {
      out.push({ area: 'Satisfaction', recommendation: `Call the ${plural(csatLow, 'customer contact')} who rated a ticket 2 or below, agree what went wrong and feed it into the next service review.`, evidence: `Average rating ${csatAvg ?? 'n/a'}/5 from ${plural(csatResponses, 'response')}; ${plural(csatLow, 'low rating')}.` });
    }
  }
  const exhausted = parts.amc.rows.filter((r) => r.status === 'exhausted');
  const warning = parts.amc.rows.filter((r) => r.status === 'warning');
  if (exhausted.length || warning.length) {
    const first = (exhausted[0] ?? warning[0])!;
    out.push({ area: 'Entitlements', recommendation: `${exhausted.length ? `Top up or renew ${plural(exhausted.length, 'exhausted entitlement')}` : `Review ${plural(warning.length, 'entitlement')} past the warning threshold`} before the next review (first: ${first.entitlement}, contract ${first.contract}).`, evidence: `${first.entitlement}: ${first.used} of ${first.quantity} ${first.unit} used (${first.pct}%); ${exhausted.length} exhausted, ${warning.length} over threshold.` });
  }
  const expiring = parts.assets.rows.length;
  if (expiring > 0) {
    const first = parts.assets.rows[0]!;
    const soonest = [...parts.assets.rows].map((r) => [r.warranty_end, r.amc_end].filter(Boolean).map(String).sort()[0]).filter(Boolean).sort()[0];
    out.push({ area: 'Asset cover', recommendation: `Renew warranty or AMC cover on ${plural(expiring, 'asset')} whose cover ends within ${EXPIRING_DAYS} days or has lapsed (first: ${first.tag ?? first.name}).`, evidence: `${plural(expiring, 'asset')} with expiring or expired cover${soonest ? `; earliest end ${String(soonest).slice(0, 10)}` : ''}.` });
  }
  if (parts.software && parts.software.overDeployed + parts.software.unlicensed > 0) {
    out.push({ area: 'Software', recommendation: `True up the ${plural(parts.software.overDeployed + parts.software.unlicensed, 'title')} installed beyond the licensed seats or without a licence before the next audit.`, evidence: `${parts.software.overDeployed} over-deployed, ${parts.software.unlicensed} unlicensed, ${parts.software.underDeployed} under-deployed of ${parts.software.titles} titles; ${parts.software.ending} licences end within ${EXPIRING_DAYS} days.` });
  }
  if (parts.pmOnTimePct !== null && parts.pmOnTimePct !== undefined && parts.pmOnTimePct < PM_TARGET) out.push({ area: 'Maintenance', recommendation: 'Re-plan the preventive maintenance calendar with the site contacts so visits land inside their grace period.', evidence: `${parts.pmOnTimePct}% of completed maintenance occurrences were on time, target ${PM_TARGET}%.` });
  if (parts.oos && parts.oos.rows.length) {
    const hours = n(summaryValue(parts.oos, 'Time spent (h)')) ?? 0;
    out.push({ area: 'Scope', recommendation: `Discuss the ${plural(parts.oos.rows.length, 'out-of-scope request')} and whether the contract scope should be extended or the work quoted separately.`, evidence: `${plural(parts.oos.rows.length, 'out-of-scope ticket')}, ${hours} h of engineering time.` });
  }
  const opened = n(summaryValue(parts.volume, 'Opened')) ?? 0;
  const resolved = n(summaryValue(parts.volume, 'Resolved')) ?? 0;
  if (!backlogRule && opened - resolved >= 5) out.push({ area: 'Backlog', recommendation: `Agree a backlog reduction plan: ${opened - resolved} more tickets were opened than resolved in the period.`, evidence: `${opened} opened, ${resolved} resolved.` });
  if (!out.length) out.push({ area: 'Service', recommendation: 'The service ran within its targets this period; keep the standing review cadence and revisit the entitlement and cover positions next month.', evidence: `${card.filter((c) => c.status === 'good').length} of ${card.length} scorecard lines on target.` });
  return out.slice(0, 8);
}

const pctStatus = (v: number | null, good: number, watch: number): Scorecard['status'] => (v === null ? 'good' : v >= good ? 'good' : v >= watch ? 'watch' : 'attention');
const lowStatus = (v: number | null, good: number, watch: number): Scorecard['status'] => (v === null ? 'good' : v <= good ? 'good' : v <= watch ? 'watch' : 'attention');
const fmtMin = (v: number | null) => (v === null ? 'n/a' : `${v} min`);
const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);

registerReport({
  key: 'service_review_pack',
  name: 'Service review pack',
  description: 'The monthly service review for one customer: scorecard, service levels, demand and workload, responsiveness, major incidents, known errors, changes, customer satisfaction, entitlements, asset cover, software, field service and recommendations, ready to send as PDF or Excel.',
  category: 'customers',
  permissions: ['reports:run', 'contracts:read', 'assets:read'],
  portal: true,
  cover: true,
  kind: 'pack',
  // the pack compares its own figures with the previous period; a second full run would double its cost
  compare: false,
  parameters: [{ ...customerParam, required: true, help: 'The pack covers one organisation' }, dateRangeParam, { key: 'recommendations', label: 'Include recommendations', type: 'boolean', default: true }],
  defaultDateRange: 'last_month',
  glossary: [
    { term: 'Scorecard status', meaning: 'On target, Watch (close to the threshold) or Needs attention, judged line by line against fixed thresholds' },
    { term: 'After-hours arrivals', meaning: 'Tickets opened outside 09:00-18:00 on weekdays, or at the weekend, in the customer timezone' },
    { term: 'Backlog ageing', meaning: 'Tickets open today bucketed by how long ago they were raised' },
  ],
  async run(ctx, p): Promise<ReportResult> {
    if (!p.customerId) throw new ValidationError('Choose a customer: the service review pack covers one organisation');
    const staff = !isCustomerUser(ctx);
    const customerId = p.customerId;
    const scope = { customerId, from: p.from, to: p.to };
    // a whole calendar month compares with the whole previous month, anything else with the same number of days before it
    const wholeMonth = p.from.endsWith('-01') && addDays(p.to, 1).endsWith('-01') && p.from.slice(0, 7) === p.to.slice(0, 7);
    const prev = previousRange({ from: p.from, to: p.to, preset: wholeMonth ? 'last_month' : 'custom', label: '' });
    const part = (key: string, overrides: Record<string, unknown> = {}, range: { from: string; to: string } = scope) => {
      const def = findReport(key);
      if (!def) throw new Error(`Report ${key} is not registered`);
      return def.run(ctx, { ...p, ...range, ...overrides } as ReportParams);
    };
    // one client per transaction: the parts run one after another
    const sla = await part('sla_performance', { ticketType: '' });
    const slaBefore = await part('sla_performance', { ticketType: '' }, prev);
    const volume = await part('ticket_volume', { granularity: 'week' });
    const incidentsAll = await part('incident_report', { majorOnly: false });
    const majorRows = incidentsAll.rows.filter((r) => r.is_major);
    const incidents: ReportResult = { ...incidentsAll, rows: majorRows };
    const amc = await part('amc_utilization', { includeInactive: false });
    const assets = await part('asset_register', { expiringOnly: true, expiringDays: EXPIRING_DAYS });
    const oos = staff ? await part('out_of_scope_activity', { includeUnknown: false }) : null;
    // optional parts: absent when the definition is missing or the caller may not run it (pm:read, field:read, surveys:read, kedb, software)
    const pm = await runPart(ctx, 'preventive_maintenance', scope);
    const visits = await runPart(ctx, 'field_visits', scope);
    const changesPart = await runPart(ctx, 'change_calendar', scope);
    const outcomes = await changeOutcomes(ctx, scope);
    const csat = await csatPart(ctx, scope);
    const kedb = await knownErrorsPart(ctx, scope);
    const software = await softwarePart(ctx, scope);
    const cab = staff ? await cabPart(ctx, scope) : null;
    // the shared analytics
    const kpis = await ticketKpis(ctx, scope);
    const previous = await ticketKpis(ctx, { ...scope, from: prev.from, to: prev.to });
    const byPriority = await breakdown(ctx, scope, 'priority');
    const byService = await breakdown(ctx, scope, 'service');
    const byCategory = await breakdown(ctx, scope, 'category');
    const bySite = await breakdown(ctx, scope, 'site');
    const byEngineer = staff ? await breakdown(ctx, scope, 'engineer') : [];
    const ageing = await backlogAgeing(ctx, { customerId });
    const resp = await responsiveness(ctx, scope);
    const timezone = await scopeTimezone(ctx, customerId);
    const heatChart = volume.charts?.find((c) => c.type === 'heatmap');
    const heatCells = (heatChart?.data ?? []).map((d) => ({ row: String(d.row ?? ''), col: String(d.col ?? ''), value: num(d.value) }));
    const afterHoursPct = afterHoursShare(heatCells);
    // the ageing buckets count tickets open today (the backlog tile and scorecard line are at period end)
    const openNow = ageing.reduce((s, a) => s + a.count, 0);
    const breachedNow = ageing.reduce((s, a) => s + a.breached, 0);

    // ---- the figures the scorecard and the tiles read
    const compliance = n(summaryValue(sla, 'Overall compliance'));
    const complianceBefore = n(summaryValue(slaBefore, 'Overall compliance'));
    const resolution = n(summaryValue(sla, 'Resolution compliance'));
    const response = n(summaryValue(sla, 'Response compliance'));
    const breaches = n(summaryValue(sla, 'Breaches')) ?? 0;
    const opened = n(summaryValue(volume, 'Opened')) ?? 0;
    const resolved = n(summaryValue(volume, 'Resolved')) ?? 0;
    const mttrMajor = n(summaryValue(incidents, 'MTTR (min)'));
    const exhausted = amc.rows.filter((r) => r.status === 'exhausted').length;
    const warning = amc.rows.filter((r) => r.status === 'warning').length;
    const oosHours = oos ? n(summaryValue(oos, 'Time spent (h)')) ?? 0 : 0;
    const csatAvg = csat ? csat.avg : null;
    const csatResponses = csat ? csat.responses : 0;
    const csatSatisfied = csat?.satisfiedPct ?? null;
    const pmOnTime = pm ? n(summaryValue(pm.result, 'On-time %')) : null;
    const pmCompleted = pm ? n(summaryValue(pm.result, 'Completed')) ?? 0 : 0;
    const pmPlanned = pm ? n(summaryValue(pm.result, 'Occurrences planned')) ?? 0 : 0;
    const pmMissed = pm ? n(summaryValue(pm.result, 'Missed')) ?? 0 : 0;
    const kedbActive = kedb ? kedb.total : 0;
    const licenceIssues = software ? software.overDeployed + software.unlicensed : 0;

    const card: Scorecard[] = [
      { area: 'Service levels', metric: 'Overall SLA compliance', value: compliance === null ? 'n/a' : `${compliance}%`, note: `${summaryHint(sla, 'Overall compliance')}${complianceBefore !== null ? `; ${complianceBefore}% in the previous period` : ''}`, status: pctStatus(compliance, SLA_TARGET, 90) },
      { area: 'Service levels', metric: 'Resolution compliance', value: resolution === null ? 'n/a' : `${resolution}%`, note: '', status: pctStatus(resolution, SLA_TARGET, 90) },
      { area: 'Service levels', metric: 'Response compliance', value: response === null ? 'n/a' : `${response}%`, note: '', status: pctStatus(response, SLA_TARGET, 90) },
      { area: 'Service levels', metric: 'SLA breaches', value: breaches, note: `${summaryValue(sla, 'Breached tickets') ?? 0} tickets`, status: breaches === 0 ? 'good' : breaches <= 3 ? 'watch' : 'attention' },
      { area: 'Responsiveness', metric: 'MTTA', value: fmtMin(kpis.mttaMinutes), note: 'mean time to first response, resolved tickets', status: lowStatus(kpis.mttaMinutes, 30, 60) },
      { area: 'Responsiveness', metric: 'MTTR', value: fmtMin(kpis.mttrMinutes), note: previous.mttrMinutes === null ? 'mean time to resolve' : `${previous.mttrMinutes} min in the previous period`, status: kpis.mttrMinutes === null || previous.mttrMinutes === null ? 'good' : kpis.mttrMinutes <= previous.mttrMinutes ? 'good' : kpis.mttrMinutes <= previous.mttrMinutes * 1.2 ? 'watch' : 'attention' },
      { area: 'Responsiveness', metric: 'First-contact resolution', value: fmtPct(kpis.fcrPct), note: `${kpis.fcr} of ${kpis.resolved} resolved without reassignment, escalation or a reopen`, status: pctStatus(kpis.fcrPct, FCR_TARGET, 55) },
      { area: 'Responsiveness', metric: 'Reopen rate', value: fmtPct(kpis.reopenPct), note: `${kpis.reopened} reopened`, status: lowStatus(kpis.reopenPct, 5, 10) },
      { area: 'Responsiveness', metric: 'Backlog at period end', value: kpis.backlogEnd, note: `${kpis.backlogStart} at the start, ${kpis.unassignedNow} unassigned now`, status: kpis.backlogEnd <= kpis.backlogStart ? 'good' : kpis.backlogEnd <= kpis.backlogStart * 1.2 ? 'watch' : 'attention' },
      { area: 'Volume', metric: 'Tickets opened', value: opened, note: `${previous.opened} in the previous period`, status: 'good' },
      { area: 'Volume', metric: 'Tickets resolved', value: resolved, note: opened > resolved ? `${opened - resolved} more opened than resolved` : 'keeping pace', status: opened - resolved >= 5 ? 'watch' : 'good' },
      { area: 'Incidents', metric: 'Major incidents', value: majorRows.length, note: mttrMajor === null ? '' : `MTTR ${mttrMajor} min`, status: majorRows.length === 0 ? 'good' : 'attention' },
      ...(csat ? [{ area: 'Satisfaction', metric: 'Customer satisfaction', value: csatAvg === null ? 'n/a' : `${csatAvg}/5`, note: `${plural(csatResponses, 'response')}, ${csatSatisfied === null ? '0%' : `${csatSatisfied}%`} satisfied`, status: pctStatus(csatAvg, CSAT_TARGET, 3.5) }] : []),
      ...(kedb ? [{ area: 'Problems', metric: 'Open known errors', value: kedbActive, note: `${kedb.fixInProgress} with a fix in progress, ${kedb.published} published to the portal`, status: lowStatus(kedbActive, 0, 3) }] : []),
      { area: 'Changes', metric: 'Change success rate', value: fmtPct(outcomes.successPct), note: `${outcomes.implemented} implemented, ${outcomes.failed} failed, ${outcomes.backedOut} backed out`, status: pctStatus(outcomes.successPct, CHANGE_TARGET, 85) },
      { area: 'Entitlements', metric: 'Entitlements over threshold', value: warning + exhausted, note: `${exhausted} exhausted`, status: exhausted ? 'attention' : warning ? 'watch' : 'good' },
      { area: 'Assets', metric: `Cover expiring within ${EXPIRING_DAYS} days or lapsed`, value: assets.rows.length, note: `${assets.rows.filter((r) => r.warranty_status === 'expired' || r.amc_status === 'expired').length} already lapsed`, status: assets.rows.length === 0 ? 'good' : 'watch' },
      ...(software ? [{ area: 'Software', metric: 'Licence position', value: licenceIssues, note: `${software.overDeployed} over-deployed, ${software.unlicensed} unlicensed of ${software.titles} titles`, status: lowStatus(licenceIssues, 0, 2) }] : []),
      ...(pm ? [{ area: 'Maintenance', metric: 'PM on time', value: fmtPct(pmOnTime), note: `${pmCompleted} of ${pmPlanned} completed, ${pmMissed} missed`, status: pctStatus(pmOnTime, PM_TARGET, 75) }] : []),
      ...(oos ? [{ area: 'Scope', metric: 'Out-of-scope requests', value: oos.rows.length, note: `${oosHours} h of engineering time`, status: (oos.rows.length === 0 ? 'good' : oos.rows.length <= 2 ? 'watch' : 'attention') as Scorecard['status'] }] : []),
    ];

    const wantRecommendations = boolParam(p, 'recommendations', true);
    const recommendations = wantRecommendations ? deterministicRecommendations(card, { sla, volume, incidents, amc, assets, oos, csat: csat?.result ?? null, kpis, previous, changes: outcomes, kedb, software, afterHoursPct, pmOnTimePct: pmOnTime }) : [];

    // ---- tiles: the six headline figures first, then the compact ones; every figure with a previous-period twin gains a delta
    const weekly = [...volume.rows].sort((a, b) => String(a.period).localeCompare(String(b.period))).slice(-12);
    const spark = (key: string) => weekly.map((r) => (r[key] === null || r[key] === undefined ? null : num(r[key])));
    const complianceTone = compliance === null ? undefined : compliance >= SLA_TARGET ? 'good' : compliance >= 90 ? 'warn' : 'bad';
    const summary: SummaryTile[] = [
      { label: 'SLA compliance', value: compliance ?? 'n/a', hint: `${plural(breaches, 'breach', 'breaches')}`, unit: 'pct', target: SLA_TARGET, tone: complianceTone },
      { label: 'Tickets opened', value: kpis.opened, spark: spark('opened') },
      { label: 'Tickets resolved', value: kpis.resolved, spark: spark('resolved') },
      { label: 'Major incidents', value: majorRows.length, tone: majorRows.length ? 'bad' : 'good' },
      { label: 'MTTR (min)', value: kpis.mttrMinutes, unit: 'minutes', spark: spark('mttr_minutes'), hint: 'mean time to resolve' },
      ...(csat ? [{ label: 'Customer satisfaction', value: csatAvg ?? 'n/a', unit: 'rating' as const, target: CSAT_TARGET, hint: plural(csatResponses, 'response'), spark: csat.series.slice(-12).map((s) => s.avg) }] : []),
      { label: 'First-contact resolution', value: kpis.fcrPct ?? 'n/a', unit: 'pct', target: FCR_TARGET },
      { label: 'Backlog', value: kpis.backlogEnd, hint: `${kpis.backlogStart} at the start of the period` },
      { label: 'Change success rate', value: outcomes.successPct ?? 'n/a', unit: 'pct', target: CHANGE_TARGET, hint: `${outcomes.total} completed` },
      { label: 'Entitlement alerts', value: warning + exhausted, hint: `${exhausted} exhausted` },
      { label: 'Cover expiring', value: assets.rows.length, hint: `within ${EXPIRING_DAYS} days` },
      ...(oos ? [{ label: 'Out of scope', value: oos.rows.length, hint: `${oosHours} h` }] : []),
      { label: 'Recommendations', value: recommendations.length },
    ];
    const before: SummaryTile[] = [
      { label: 'SLA compliance', value: complianceBefore ?? 'n/a' },
      { label: 'Tickets opened', value: previous.opened },
      { label: 'Tickets resolved', value: previous.resolved },
      { label: 'Major incidents', value: previous.major },
      { label: 'MTTR (min)', value: previous.mttrMinutes },
      { label: 'First-contact resolution', value: previous.fcrPct ?? 'n/a' },
      // the backlog at the start of the period is the previous period's end
      { label: 'Backlog', value: kpis.backlogStart },
    ];
    attachDeltas({ columns: [], rows: [], summary }, { columns: [], rows: [], summary: before });

    // ---- sections, grouped into chapters; every section is always returned (the document hides empty ones)
    const hidden = staff ? [] : ['assignee', 'engineer', 'owner', 'recorded_by', 'decided_by', 'chair'];
    const drop = (cols: ReportColumn[], keys: string[] = []) => cols.filter((c) => !keys.includes(c.key) && c.key !== 'customer' && !hidden.includes(c.key));
    const cap = (list: Record<string, unknown>[], max = TABLE_CAP) => list.slice(0, max);
    const callout = (kind: Insight['kind'], area: string, text: string, evidence?: string): Insight => ({ kind, area, text, evidence, weight: 5 });
    const chart = (c: ReportChart | undefined, patch: Partial<ReportChart> = {}): ReportChart[] => (c && c.data.length ? [{ ...c, ...patch }] : []);
    const find = (r: ReportResult | null | undefined, title: string) => r?.charts?.find((c) => c.title === title);
    const breakdownColumns = (first: ReportColumn) => [first, col('opened', 'Opened', 'number'), col('resolved', 'Resolved', 'number'), col('mttrMinutes', 'MTTR', 'minutes'), col('breaches', 'Resolution breaches', 'number'), col('compliancePct', 'Compliance', 'pct')];
    const breakdownRows = (list: typeof byPriority) => list.map((r) => ({ label: r.label, opened: r.opened, resolved: r.resolved, mttrMinutes: r.mttrMinutes, breaches: r.breaches, compliancePct: r.compliancePct }));
    const ratingDistribution: ReportChart = { type: 'bar', title: 'Rating distribution', subtitle: '1 (very dissatisfied) to 5 (very satisfied)', data: ([1, 2, 3, 4, 5] as const).map((r) => ({ label: RATING_MEANING[r - 1], count: csat?.distribution[r] ?? 0 })), x: 'label', y: 'count', statusSeries: true, insight: 'none' };
    const volumeIntro = `${kpis.opened} tickets opened and ${kpis.resolved} resolved${previous.opened ? ` (${previous.opened} and ${previous.resolved} in the previous period)` : ''}.`;
    const sections: ReportSection[] = [
      // Service levels
      { group: 'Service levels', title: 'SLA by priority and metric', intro: `Clocks met and breached per priority and metric; target ${SLA_TARGET}% compliance.`, columns: sla.columns, rows: sla.rows, totals: true, charts: [...chart(find(sla, 'Overall SLA compliance')), ...chart(find(sla, 'Met vs breached by metric'))] },
      ...(sla.sections ?? []).map((s) => ({ ...s, group: 'Service levels', columns: drop(s.columns), printLimit: 25 })),
      // Demand and workload
      {
        group: 'Demand and workload',
        title: 'Ticket volume by week',
        intro: volumeIntro,
        columns: drop(volume.columns, ['p1', 'p2', 'p3', 'p4_plus', 'out_of_scope']),
        rows: volume.rows,
        totals: true,
        charts: [
          ...chart(find(volume, 'Opened by type')),
          { type: 'donut', title: 'Opened by priority', data: byPriority.map((r) => ({ label: r.label, count: r.opened })), x: 'label', y: 'count', insight: 'none' },
          ...chart(heatChart),
          { type: 'bar', title: 'Top services by tickets', data: byService.slice(0, 8).map((r) => ({ label: r.label, count: r.opened })), x: 'label', y: 'count', horizontal: true },
          { type: 'bar', title: 'Top categories by tickets', data: byCategory.slice(0, 8).map((r) => ({ label: r.label, count: r.opened })), x: 'label', y: 'count', horizontal: true },
        ],
        callouts: afterHoursPct !== null ? [callout(afterHoursPct >= 35 ? 'attention' : 'info', 'Demand', `${afterHoursPct}% of tickets arrived outside 09:00-18:00 on weekdays or at the weekend (${timezone})`)] : [],
      },
      { group: 'Demand and workload', title: 'By site', intro: 'Tickets opened in the period by the site they were raised for.', columns: breakdownColumns(col('label', 'Site')), rows: breakdownRows(bySite), totals: true },
      // Responsiveness
      {
        group: 'Responsiveness',
        title: 'Responsiveness by priority',
        intro: `MTTA ${fmtMin(kpis.mttaMinutes)}, MTTR ${fmtMin(kpis.mttrMinutes)}, first-contact resolution ${fmtPct(kpis.fcrPct)}, reopen rate ${fmtPct(kpis.reopenPct)} across the period.`,
        columns: [col('priority', 'Priority'), col('opened', 'Opened', 'number'), col('resolved', 'Resolved', 'number'), col('mttaMinutes', 'MTTA', 'minutes'), col('mttrMinutes', 'MTTR', 'minutes'), col('fcrPct', 'First-contact resolution', 'pct'), col('reopenPct', 'Reopen rate', 'pct')],
        rows: resp.map((r) => ({ priority: r.priority, opened: r.opened, resolved: r.resolved, mttaMinutes: r.mttaMinutes, mttrMinutes: r.mttrMinutes, fcrPct: r.fcrPct, reopenPct: r.reopenPct })),
        charts: [
          { type: 'bar', title: 'MTTA and MTTR by priority', data: resp.map((r) => ({ label: r.priority, mtta: r.mttaMinutes ?? 0, mttr: r.mttrMinutes ?? 0 })), x: 'label', y: ['mtta', 'mttr'], labels: { mtta: 'MTTA', mttr: 'MTTR' }, unit: 'minutes', insight: 'none' },
          { type: 'bar', title: 'Backlog ageing', subtitle: `${openNow} tickets open today by age`, data: ageing.map((a) => ({ label: a.bucket, count: a.count })), x: 'label', y: 'count', emphasis: AGE_ORDER[AGE_ORDER.length - 1], insight: 'none' },
        ],
        callouts: breachedNow ? [callout('attention', 'Responsiveness', `${breachedNow} of the ${openNow} tickets open today have already breached a clock`, ageing.filter((a) => a.breached).map((a) => `${a.bucket}: ${a.breached}`).join(', '))] : [],
      },
      ...(staff ? [{ group: 'Responsiveness', title: 'Resolution by engineer', intro: 'Tickets opened in the period by the engineer they are assigned to.', columns: breakdownColumns(col('label', 'Engineer')), rows: breakdownRows(byEngineer), totals: true, charts: [{ type: 'bar', title: 'Tickets resolved by engineer', data: byEngineer.slice(0, 10).map((r) => ({ label: r.label, count: r.resolved })), x: 'label', y: 'count', horizontal: true, insight: 'none' } as ReportChart] }] : []),
      // Major incidents
      { title: 'Major incidents', columns: drop(incidents.columns, ['is_major', 'site', 'response_minutes', 'category', 'ci']), rows: majorRows, callouts: majorRows.length ? [] : [callout('good', 'Incidents', 'No major incidents in the period')] },
      // Problems and known errors
      { group: 'Problems and known errors', title: 'Known errors', intro: 'Known errors active for this organisation, with the workaround on record.', columns: kedb ? drop(kedb.result.columns, ['root_cause', 'identified_at', 'ke_status_at', 'updated_at']) : [], rows: kedb ? cap(kedb.result.rows) : [], charts: kedb ? chart(find(kedb.result, 'Known errors by status')) : [], callouts: kedb && kedb.total ? [callout(kedb.open ? 'attention' : 'info', 'Problems', `${plural(kedb.total, 'active known error')}: ${kedb.open} open, ${kedb.fixInProgress} with a fix in progress, ${kedb.published} published to the portal`, `${kedb.linkedIncidents} linked incidents`)] : [] },
      // Changes
      { group: 'Changes', title: 'Changes in the period', intro: `${outcomes.total} changes completed in the period; success rate ${fmtPct(outcomes.successPct)} against a ${CHANGE_TARGET}% target.`, columns: changesPart ? drop(changesPart.result.columns, ['risk', 'risk_score', 'cab_meeting', 'scheduled_end', 'downtime_expected_minutes', 'service', 'template', 'category']) : [], rows: changesPart ? cap(changesPart.result.rows, 25) : [], printLimit: 25, charts: changesPart ? [...chart(find(changesPart.result, 'Changes per week by type')), ...chart(find(changesPart.result, 'Changes by status'))] : [], callouts: outcomes.total ? [callout(outcomes.successPct !== null && outcomes.successPct < CHANGE_TARGET ? 'attention' : 'good', 'Changes', `${outcomes.implemented} implemented, ${outcomes.failed} failed, ${outcomes.backedOut} backed out (${outcomes.emergency} emergency, ${outcomes.standard} standard)`)] : [] },
      { group: 'Changes', title: 'Failed or backed out', columns: drop([col('number', 'Number'), col('title', 'Title'), col('changeType', 'Type'), col('outcome', 'Outcome'), col('scheduledStart', 'Scheduled start', 'datetime'), col('assignee', 'Assignee')]), rows: outcomes.failedList.map((r) => ({ ...r })) },
      ...(staff ? [{ group: 'Changes', title: 'CAB decisions', intro: 'Decisions taken at CAB meetings in the period.', columns: cab ? drop(cab.result.columns, ['meeting_id', 'meeting_status', 'chair', 'decided_at']) : [], rows: cab ? cap(cab.result.rows) : [] }] : []),
      // Customer satisfaction
      ...(csat
        ? [
            { group: 'Customer satisfaction', title: 'Customer satisfaction by service', intro: `${plural(csatResponses, 'response')} to ${csat.sent} surveys; average ${csatAvg === null ? 'n/a' : `${csatAvg}/5`}, ${csatSatisfied === null ? '0%' : `${csatSatisfied}%`} satisfied, ${plural(csat.low, 'low rating')}.`, columns: drop(csat.result.columns), rows: csat.result.rows, charts: [...(csatResponses ? [ratingDistribution] : []), ...chart(find(csat.result, 'Average rating per week'))] },
            ...(csat.result.sections ?? []).filter((x) => x.title === 'Lowest-rated tickets').map((x) => ({ ...x, group: 'Customer satisfaction', columns: drop(x.columns), rows: cap(x.rows, 10) })),
          ]
        : []),
      // Contracts and entitlements
      { group: 'Contracts and entitlements', title: 'Entitlement utilisation', intro: 'Consumed against entitled in the current window of each contract.', columns: drop(amc.columns, ['type', 'service', 'period_start', 'period_end', 'contract_name', 'contract_status']), rows: amc.rows, charts: chart(find(amc, 'Utilization % (top 15)')) },
      ...(amc.sections ?? []).filter((s) => s.title === 'Consumption detail').map((s) => ({ ...s, group: 'Contracts and entitlements', columns: drop(s.columns, ['notes']), rows: cap(s.rows, 10) })),
      // Assets and software
      { group: 'Assets and software', title: 'Expiring asset cover', intro: `Assets whose warranty or AMC cover ends within ${EXPIRING_DAYS} days or has already lapsed.`, columns: drop(assets.columns, ['manufacturer', 'model', 'serial_number', 'lifecycle_stage', 'eol_date', 'ci']), rows: cap(assets.rows) },
      { group: 'Assets and software', title: 'Software positions', intro: 'Installed against entitled per title.', columns: software ? drop(software.result.columns, ['version_family', 'licences_active', 'expiring_seats']) : [], rows: software ? cap(software.result.rows) : [], charts: software ? chart(find(software.result, 'Positions'), { type: 'donut', title: 'Licence positions', insight: 'none' }) : [] },
      // Field service and maintenance
      { group: 'Field service and maintenance', title: 'Preventive maintenance', intro: pm ? `${pmCompleted} of ${pmPlanned} planned occurrences completed, ${pmMissed} missed; on time ${fmtPct(pmOnTime)}.` : undefined, columns: pm ? drop(pm.result.sections?.[0]?.columns ?? []) : [], rows: pm ? cap(pm.result.sections?.[0]?.rows ?? []) : [], charts: pm ? chart(find(pm.result, 'Planned vs completed per month')) : [] },
      { group: 'Field service and maintenance', title: 'Field visits', columns: visits ? drop(visits.result.columns, ['title', 'parts', 'ticket', 'actual_start', 'travel_minutes', 'acknowledged']) : [], rows: visits ? cap(visits.result.rows) : [], charts: visits ? chart(find(visits.result, 'Visits by status')) : [] },
      // Scope (staff)
      ...(oos ? [{ title: 'Out-of-scope work', columns: drop(oos.columns, ['scope_status', 'contract', 'visits', 'type', 'priority']), rows: oos.rows }] : []),
      // Recommendations last
      ...(recommendations.length ? [{ title: 'Recommendations', intro: 'Drawn from the figures above by fixed rules; the evidence names the figures each one rests on.', columns: [col('area', 'Area'), col('recommendation', 'Recommendation'), col('evidence', 'Evidence')], rows: recommendations.map((r) => ({ ...r })) }] : []),
    ];
    // a customer's copy keeps only the printed columns inside every row: a dropped staff-name column never travels in the row objects of the JSON preview either
    const fenced = staff ? sections : sections.map((s) => ({ ...s, rows: s.rows.map((r) => Object.fromEntries(s.columns.map((c) => [c.key, r[c.key]]))) }));
    const unavailable = PART_DEFINITIONS.filter(([key]) => !findReport(key)).map(([, name]) => name);
    const charts: ReportChart[] = [...chart(find(volume, 'Opened vs resolved'), { title: 'Opened vs resolved per week' }), ...chart(find(sla, 'Compliance % by priority'))];
    return {
      columns: [col('area', 'Area'), col('metric', 'Measure'), col('value', 'Value'), col('status', 'Status'), col('note', 'Note')],
      rows: card.map((c) => ({ ...c, status: c.status === 'good' ? 'On target' : c.status === 'watch' ? 'Watch' : 'Needs attention' })),
      summary,
      charts,
      sections: fenced,
      recommendations,
      comparison: { from: prev.from, to: prev.to, label: prev.label },
      notes: [`Previous period for the deltas: ${prev.from} to ${prev.to}`, ...(unavailable.length ? [`Parts not available on this installation: ${unavailable.join(', ')}`] : [])],
    };
  },
});
