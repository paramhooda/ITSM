import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareHeart, Download } from 'lucide-react';
import { PageHeader, Pagination, EmptyState, LoadingBlock, ErrorBlock, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, DataTable, type AppliedFilter, type Column } from '@/components/ui';
import { REPORT_MODULES } from '@/layouts/modules';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { dotClass, truncate } from '@/lib/utils';
import { CSAT_RATING_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { surveysApi, surveyKeys, CHANNEL_LABELS, RATING_LABELS, type SurveyResponse, type CsatGroupBy } from '@/components/surveys/api';
import { RatingBadge } from '@/components/surveys/RatingBadge';
import { csatTiles } from '@/components/surveys/CsatTiles';

const DEFAULTS = { days: '30', pageSize: '25' };
const FILTER_KEYS = ['q', 'customerId', 'assigneeId', 'teamId', 'serviceId', 'rating', 'channel', 'low'];
const PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
];
const GROUPS: { value: CsatGroupBy; label: string; filterKey: string }[] = [
  { value: 'customer', label: 'Customer', filterKey: 'customerId' },
  { value: 'engineer', label: 'Engineer', filterKey: 'assigneeId' },
  { value: 'team', label: 'Team', filterKey: 'teamId' },
  { value: 'service', label: 'Service', filterKey: 'serviceId' },
];

/** Customer satisfaction module of Reports: the figures, the trend, the breakdown and every response with its comment. */
export default function CsatPage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const engineerItems = engineers.data ?? [];
  const teams = lookups?.teams ?? [];
  const services = lookups?.services ?? [];
  const [trendView, setTrendView] = useState<'avg' | 'responses'>('avg');
  const groupBy = (GROUPS.find((g) => g.value === state.groupBy)?.value ?? 'customer') as CsatGroupBy;
  const days = Number(state.days) || 30;

  const scope = useMemo(
    () => ({ days, customerId: state.customerId || undefined, assigneeId: state.assigneeId || undefined, teamId: state.teamId || undefined, serviceId: state.serviceId || undefined }),
    [days, state.customerId, state.assigneeId, state.teamId, state.serviceId],
  );
  const summaryQuery = useMemo(() => ({ ...scope, groupBy }), [scope, groupBy]);
  const listQuery = useMemo(
    () => ({ ...scope, page, pageSize, q: state.q || undefined, rating: state.rating || undefined, channel: state.channel || undefined, low: state.low === 'true' ? 'true' : undefined, sort: state.sort || undefined, order: state.order || undefined }),
    [scope, page, pageSize, state.q, state.rating, state.channel, state.low, state.sort, state.order],
  );
  const summary = useQuery({ queryKey: surveyKeys.summary(summaryQuery), queryFn: () => surveysApi.summary(summaryQuery), placeholderData: (prev) => prev, staleTime: 60_000 });
  const list = useQuery({ queryKey: surveyKeys.responses(listQuery), queryFn: () => surveysApi.responses(listQuery), placeholderData: (prev) => prev });
  const s = summary.data;

  const activeCount = FILTER_KEYS.filter((k) => state[k]).length + (state.days && state.days !== DEFAULTS.days ? 1 : 0);
  const clear = () => set(Object.fromEntries([...FILTER_KEYS, 'days', 'groupBy'].map((k) => [k, undefined])));
  const toggleLow = () => set({ low: state.low === 'true' ? undefined : 'true' });

  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.days && state.days !== DEFAULTS.days) applied.push({ key: 'days', label: PERIODS.find((p) => p.value === state.days)?.label ?? `${state.days} days`, onRemove: () => set({ days: undefined }) });
  if (state.customerId) applied.push({ key: 'customerId', label: `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, onRemove: () => set({ customerId: undefined }) });
  if (state.assigneeId) applied.push({ key: 'assigneeId', label: `Engineer: ${engineerItems.find((e) => e.id === state.assigneeId)?.name ?? '…'}`, onRemove: () => set({ assigneeId: undefined }) });
  if (state.teamId) applied.push({ key: 'teamId', label: `Team: ${teams.find((t) => t.id === state.teamId)?.name ?? '…'}`, onRemove: () => set({ teamId: undefined }) });
  if (state.serviceId) applied.push({ key: 'serviceId', label: `Service: ${services.find((sv) => sv.id === state.serviceId)?.name ?? '…'}`, onRemove: () => set({ serviceId: undefined }) });
  if (state.rating) applied.push({ key: 'rating', label: `Rating: ${state.rating}/5`, onRemove: () => set({ rating: undefined }) });
  if (state.channel) applied.push({ key: 'channel', label: `Channel: ${CHANNEL_LABELS[state.channel] ?? state.channel}`, onRemove: () => set({ channel: undefined }) });
  if (state.low === 'true') applied.push({ key: 'low', label: 'Low ratings only', onRemove: () => set({ low: undefined }) });

  const filters = (
    <>
      <FilterGroup label="Period">
        <FilterOptions options={PERIODS} value={state.days ?? DEFAULTS.days} onChange={(v) => set({ days: (v as string | undefined) || undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="Any customer" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Engineer">
        <FilterSelect value={state.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value })} placeholder="Any engineer" options={engineerItems.map((e) => ({ value: e.id, label: e.name }))} />
      </FilterGroup>
      <FilterGroup label="Team">
        <FilterSelect value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Any team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
      </FilterGroup>
      <FilterGroup label="Service">
        <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
      </FilterGroup>
      <FilterGroup label="Rating">
        <FilterOptions options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} · ${RATING_LABELS[n]}`, dot: dotClass(CSAT_RATING_COLORS[n]), count: s?.figures.distribution[String(n) as '1'] ?? null }))} value={state.rating} onChange={(v) => set({ rating: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Channel" hint="How the customer answered">
        <FilterOptions options={Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }))} value={state.channel} onChange={(v) => set({ channel: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Low ratings" hint={s ? `Rated ${s.thresholds.low} or less` : undefined}>
        <FilterToggle label="Low ratings only" checked={state.low === 'true'} onChange={(v) => set({ low: v ? 'true' : undefined })} />
      </FilterGroup>
    </>
  );

  const columns: Column<SurveyResponse>[] = [
    { key: 'number', header: 'Ticket', width: '112px', render: (r) => <span className="font-mono text-[12px] text-secondary whitespace-nowrap">{r.number}</span> },
    {
      key: 'title',
      header: 'Summary',
      render: (r) => (
        <div className="min-w-[200px] max-w-[360px]">
          <div className="truncate font-medium text-[13.5px]">{r.title}</div>
          <div className="text-[11.5px] text-muted truncate">{r.customerName ?? '—'}{r.serviceName ? ` · ${r.serviceName}` : ''}</div>
        </div>
      ),
    },
    { key: 'rating', header: 'Rating', width: '90px', sortable: true, render: (r) => <RatingBadge rating={r.rating} /> },
    { key: 'comment', header: 'Comment', render: (r) => (r.comment ? <span className="text-[12.5px] block max-w-[360px] truncate" title={r.comment}>{truncate(r.comment, 120)}</span> : <span className="text-subtle">—</span>) },
    { key: 'respondent', header: 'Respondent', render: (r) => <span className="whitespace-nowrap text-[12.5px]">{r.respondentName ?? <span className="text-subtle">—</span>}</span> },
    { key: 'channel', header: 'Channel', width: '100px', render: (r) => <span className="text-[12.5px] text-muted">{r.channel ? CHANNEL_LABELS[r.channel] ?? r.channel : '—'}</span> },
    { key: 'answeredAt', header: 'Answered', width: '110px', sortable: true, render: (r) => <span className="text-muted whitespace-nowrap" title={r.answeredAt ? fmtDateTime(r.answeredAt) : undefined}>{r.answeredAt ? relativeTime(r.answeredAt) : '—'}</span> },
    { key: 'engineer', header: 'Engineer', className: 'hidden xl:table-cell', render: (r) => <span className="text-[12.5px] whitespace-nowrap">{r.assigneeName ?? <span className="text-subtle">—</span>}</span> },
    { key: 'team', header: 'Team', className: 'hidden 2xl:table-cell', render: (r) => <span className="text-[12.5px] text-muted whitespace-nowrap">{r.teamName ?? '—'}</span> },
  ];
  const sort = state.sort ? { key: state.sort, order: (state.order as 'asc' | 'desc') || 'desc' } : undefined;
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && (state.order ?? 'desc') === 'desc' ? 'asc' : 'desc' });

  const groupMeta = GROUPS.find((g) => g.value === groupBy)!;
  // Bar length is the response count (volume); the average sits in the label and sets the colour.
  const breakdown = (s?.groups ?? []).filter((g) => g.responses > 0).map((g) => ({ label: `${g.label} · ${g.avg == null ? '—' : `${g.avg.toFixed(1)}/5`}`, value: g.responses, color: CSAT_RATING_COLORS[Math.round(g.avg ?? 0)] ?? 'slate', active: !!g.key && state[groupMeta.filterKey] === g.key }));
  const trendData = (s?.figures.series ?? []).map((p) => ({ week: p.week, avg: p.avg, responses: p.responses }));
  const distribution = s ? [5, 4, 3, 2, 1].map((n) => ({ label: `${n} · ${RATING_LABELS[n]}`, value: s.figures.distribution[String(n) as '1'] ?? 0, color: CSAT_RATING_COLORS[n], active: state.rating === String(n) })) : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Customer satisfaction" subtitle="How customers rated the tickets we resolved, with every comment" />
      <ListShell
        id="csat-responses"
        modules={REPORT_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search comments and ticket numbers…' }}
        filters={filters}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} ${list.data.total === 1 ? 'response' : 'responses'}` : undefined}
        toolbar={
          <Link to={`/reports?tab=run&report=csat_responses${state.customerId ? `&customerId=${state.customerId}` : ''}`} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-default bg-white text-[12.5px] font-medium hover:bg-surface-2">
            <Download className="h-3.5 w-3.5" /> Export
          </Link>
        }
        insights={
          <InsightBand
            id="csat"
            columns={5}
            loading={summary.isLoading}
            summary={s ? `${fmtNumber(s.figures.responses)} ${s.figures.responses === 1 ? 'response' : 'responses'} in the last ${s.period.days} days${state.customerId ? ' for this customer' : ''} · ${fmtDate(s.period.from)} to ${fmtDate(s.period.to)}` : undefined}
            kpis={csatTiles(s?.figures, { thresholds: s?.thresholds, onLow: toggleLow, lowActive: state.low === 'true' })}
            panels={
              s && (
                <>
                  <Panel title="Trend" subtitle={trendView === 'avg' ? 'Average rating per week' : 'Responses per week'} action={<Segmented size="sm" options={[{ value: 'avg', label: 'Average' }, { value: 'responses', label: 'Responses' }]} value={trendView} onChange={setTrendView} />}>
                    {trendView === 'avg' ? (
                      <TrendChart data={trendData} x="week" kind="line" series={[{ key: 'avg', label: 'Average rating', color: '#0f9d6f' }]} height={200} yDomain={[1, 5]} yTicks={[1, 2, 3, 4, 5]} yFormatter={(v) => String(v)} valueFormatter={(v) => `${v.toFixed(1)}/5`} />
                    ) : (
                      <TrendChart data={trendData} x="week" kind="bar" series={[{ key: 'responses', label: 'Responses' }]} height={200} />
                    )}
                  </Panel>
                  <Panel title="Breakdown" subtitle={`By ${groupMeta.label.toLowerCase()}: average rating, responses on the right`} action={<Segmented size="sm" options={GROUPS.map((g) => ({ value: g.value, label: g.label }))} value={groupBy} onChange={(v) => set({ groupBy: v === 'customer' ? undefined : v })} />}>
                    <BreakdownBar
                      dense
                      emptyText="No responses in this period"
                      items={breakdown}
                      onSelect={(i) => {
                        const g = s.groups.find((x) => i.label.startsWith(`${x.label} · `));
                        if (g?.key) set({ [groupMeta.filterKey]: state[groupMeta.filterKey] === g.key ? undefined : g.key });
                      }}
                      scrollTo
                    />
                  </Panel>
                  <Panel title="Distribution" subtitle="Responses by rating">
                    <BreakdownBar dense emptyText="No responses in this period" items={distribution} onSelect={(i) => { const n = i.label.slice(0, 1); set({ rating: state.rating === n ? undefined : n }); }} scrollTo />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        <div className="card overflow-hidden">
          {list.isLoading && <LoadingBlock />}
          {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
          {list.data && list.data.items.length === 0 && (
            <EmptyState
              icon={<MessageSquareHeart className="h-5 w-5" />}
              title={activeCount > 0 ? 'No responses match' : 'No survey responses yet'}
              description={activeCount > 0 ? 'Adjust the filters or widen the period.' : 'Responses appear here once customers rate resolved tickets.'}
              action={activeCount > 0 ? undefined : <Link to="/admin/surveys" className="text-[13px] text-brand-700 hover:underline">Survey policies</Link>}
            />
          )}
          {list.data && list.data.items.length > 0 && (
            <>
              <DataTable columns={columns} rows={list.data.items} dense sort={sort} onSort={onSort} onRowClick={(r) => navigate(`/tickets/${r.ticketId}`)} rowClassName={(r) => (r.rating != null && s && r.rating <= s.thresholds.low ? 'row-rail-bad' : undefined)} />
              <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
            </>
          )}
        </div>
      </ListShell>
    </div>
  );
}
