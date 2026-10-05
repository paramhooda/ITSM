import type { Ctx } from '@/core/context';
import { registerReport, isCustomerUser, type ReportResult, type ReportParams } from '../registry';
import { col, customerParam, dateRangeParam, strParam, boolParam } from './helpers';
import { csatFigures, csatGroups, csatLowest, hidesSoc, type CsatFilter } from '@/modules/surveys/figures';
import { loadSurveyDefaults } from '@/modules/surveys/policy';
import { listResponses } from '@/modules/surveys/service';
import { GROUP_BY, type GroupBy } from '@/modules/surveys/schemas';

/**
 * Customer satisfaction as reports: the summary (figures, breakdown, weekly
 * trend, distribution, lowest-rated tickets) and the response list. Portal
 * users are pinned to their organisation by the registry and never see an
 * engineer or team; staff need surveys:read. Summary tile labels and section
 * titles are read by name by the review pack and the document layer: keep them.
 */

const fmtAvg = (v: number | null) => (v === null ? 'n/a' : `${v}/5`);
const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
const PORTAL_GROUPS: GroupBy[] = ['service', 'priority', 'month'];

async function filterOf(ctx: Ctx, p: ReportParams): Promise<CsatFilter> {
  const defaults = await loadSurveyDefaults(ctx.tx);
  const customerId = isCustomerUser(ctx) ? ctx.user.customerId : p.customerId;
  return { customerId, from: new Date(`${p.from}T00:00:00.000Z`), to: new Date(`${p.to}T23:59:59.999Z`), excludeSoc: hidesSoc(ctx), satisfiedThreshold: defaults.satisfiedThreshold, lowThreshold: defaults.lowRatingThreshold };
}

registerReport({
  key: 'csat_summary',
  name: 'Customer satisfaction summary',
  description: 'CSAT from the surveys sent when tickets end: average rating, share satisfied, response rate, low ratings, a breakdown by customer, engineer, team, service, priority or month, the weekly trend and the lowest-rated tickets.',
  category: 'customers',
  permissions: ['reports:run', 'surveys:read'],
  portal: true,
  parameters: [
    customerParam,
    dateRangeParam,
    { key: 'groupBy', label: 'Breakdown', type: 'select', options: [{ value: 'customer', label: 'Customer' }, { value: 'engineer', label: 'Engineer' }, { value: 'team', label: 'Team' }, { value: 'service', label: 'Service' }, { value: 'priority', label: 'Priority' }, { value: 'month', label: 'Month' }], default: 'customer', help: 'Customer users can break down by service, priority or month' },
  ],
  defaultDateRange: 'last_30_days',
  async run(ctx, p): Promise<ReportResult> {
    const customer = isCustomerUser(ctx);
    if (!customer) ctx.require('surveys:read', p.customerId);
    const requested = strParam(p, 'groupBy');
    let groupBy: GroupBy = (GROUP_BY as readonly string[]).includes(requested ?? '') ? (requested as GroupBy) : 'customer';
    if (customer && !PORTAL_GROUPS.includes(groupBy)) groupBy = 'service';
    const f = await filterOf(ctx, p);
    const figures = await csatFigures(ctx.tx, f);
    const groups = await csatGroups(ctx.tx, { ...f, groupBy });
    const lowest = await csatLowest(ctx.tx, f, 20);
    const groupLabel = groupBy === 'engineer' ? 'Engineer' : groupBy.charAt(0).toUpperCase() + groupBy.slice(1);
    const lowestColumns = [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('rating', 'Rating', 'number'), col('comment', 'Comment'), col('answered_at', 'Answered', 'datetime'), ...(customer ? [] : [col('engineer', 'Engineer')])];
    return {
      columns: [col('label', groupLabel), col('sent', 'Surveys sent', 'number'), col('responses', 'Responses', 'number'), col('response_rate', 'Response rate', 'pct'), col('avg_rating', 'Average rating', 'number'), col('satisfied_pct', 'Satisfied', 'pct'), col('low', 'Low ratings', 'number')],
      rows: groups.map((g) => ({ key: g.key, label: g.label, sent: g.sent, responses: g.responses, response_rate: g.sent > 0 ? Math.round((g.responses / g.sent) * 1000) / 10 : null, avg_rating: g.avg, satisfied_pct: g.satisfiedPct, low: g.low })),
      summary: [
        { label: 'Responses', value: figures.responses, hint: `${figures.sent} sent` },
        { label: 'Surveys sent', value: figures.sent },
        { label: 'Response rate', value: fmtPct(figures.responseRate) },
        { label: 'Average rating', value: fmtAvg(figures.avg), hint: `${figures.responses} responses` },
        { label: 'Satisfied', value: fmtPct(figures.satisfiedPct), hint: `rated ${f.satisfiedThreshold} or more` },
        { label: 'Low ratings', value: figures.low, hint: `rated ${f.lowThreshold} or less` },
      ],
      charts: [
        { type: 'bar', title: `Average rating by ${groupLabel.toLowerCase()}`, data: groups.filter((g) => g.avg !== null).slice(0, 12).map((g) => ({ label: g.label, avg: g.avg })), x: 'label', y: 'avg', labels: { avg: 'Average rating' } },
        { type: 'line', title: 'Average rating per week', data: figures.series.map((s) => ({ week: s.week, avg: s.avg, responses: s.responses })), x: 'week', y: 'avg', labels: { avg: 'Average rating' } },
      ],
      sections: [
        { title: 'Rating distribution', columns: [col('rating', 'Rating'), col('label', 'Meaning'), col('count', 'Responses', 'number'), col('share', 'Share', 'pct')], rows: ([1, 2, 3, 4, 5] as const).map((r) => ({ rating: `${r}/5`, label: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'][r - 1], count: figures.distribution[String(r) as keyof typeof figures.distribution], share: figures.responses ? Math.round((figures.distribution[String(r) as keyof typeof figures.distribution] / figures.responses) * 1000) / 10 : null })) },
        { title: 'Lowest-rated tickets', columns: lowestColumns, rows: lowest.map((l) => ({ id: l.ticketId, number: l.number, title: l.title, customer: l.customerName, rating: l.rating, comment: l.comment, answered_at: l.answeredAt, ...(customer ? {} : { engineer: l.assigneeName }) })) },
      ],
    };
  },
});

registerReport({
  key: 'csat_responses',
  name: 'Customer satisfaction responses',
  description: 'Every survey response in the period with the rating, the comment, the respondent and the channel; filter by rating, low ratings only or channel.',
  category: 'customers',
  permissions: ['reports:run', 'surveys:read'],
  portal: true,
  parameters: [
    customerParam,
    dateRangeParam,
    { key: 'rating', label: 'Rating', type: 'select', options: [{ value: '', label: 'Any' }, { value: '1', label: '1 · Very dissatisfied' }, { value: '2', label: '2 · Dissatisfied' }, { value: '3', label: '3 · Neutral' }, { value: '4', label: '4 · Satisfied' }, { value: '5', label: '5 · Very satisfied' }] },
    { key: 'lowOnly', label: 'Low ratings only', type: 'boolean' },
    { key: 'channel', label: 'Channel', type: 'select', options: [{ value: '', label: 'Any' }, { value: 'email', label: 'Email link' }, { value: 'portal', label: 'Portal' }, { value: 'assistant', label: 'Assistant' }] },
  ],
  defaultDateRange: 'last_30_days',
  async run(ctx, p): Promise<ReportResult> {
    const customer = isCustomerUser(ctx);
    const rating = strParam(p, 'rating');
    const channel = strParam(p, 'channel');
    const res = await listResponses(ctx, {
      page: 1,
      pageSize: 500,
      customerId: customer ? undefined : (p.customerId ?? undefined),
      from: p.from,
      to: p.to,
      status: 'answered',
      rating: rating && /^[1-5]$/.test(rating) ? Number(rating) : undefined,
      low: boolParam(p, 'lowOnly') || undefined,
      channel: channel === 'email' || channel === 'portal' || channel === 'assistant' ? channel : undefined,
      sort: 'answeredAt',
      order: 'desc',
    });
    const items = res.items;
    const responses = items.length;
    const defaults = await loadSurveyDefaults(ctx.tx);
    const avg = responses ? Math.round((items.reduce((s, r) => s + (r.rating ?? 0), 0) / responses) * 10) / 10 : null;
    const satisfied = items.filter((r) => (r.rating ?? 0) >= defaults.satisfiedThreshold).length;
    const columns = [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('rating', 'Rating', 'number'), col('comment', 'Comment'), col('respondent', 'Respondent'), col('channel', 'Channel'), col('requested_at', 'Requested', 'datetime'), col('answered_at', 'Answered', 'datetime'), ...(customer ? [] : [col('engineer', 'Engineer'), col('team', 'Team')]), col('service', 'Service'), col('trigger', 'Sent on')];
    return {
      columns,
      rows: items.map((r) => ({ id: r.ticketId, number: r.number, title: r.title, customer: r.customerName, rating: r.rating, comment: r.comment, respondent: r.respondentName, channel: r.channel, requested_at: r.requestedAt, answered_at: r.answeredAt, ...(customer ? {} : { engineer: r.assigneeName ?? null, team: r.teamName ?? null }), service: r.serviceName, trigger: r.trigger })),
      summary: [
        { label: 'Responses', value: responses },
        { label: 'Average rating', value: fmtAvg(avg) },
        { label: 'Satisfied', value: responses ? `${Math.round((satisfied / responses) * 1000) / 10}%` : 'n/a' },
      ],
      charts: [{ type: 'bar', title: 'Responses by rating', data: [1, 2, 3, 4, 5].map((r) => ({ label: `${r}/5`, count: items.filter((i) => i.rating === r).length })), x: 'label', y: 'count' }],
      truncated: res.total > items.length,
    };
  },
});
