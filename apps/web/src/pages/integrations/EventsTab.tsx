import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, ShieldAlert, Webhook, AlertTriangle, Activity, Ticket, Copy, Building2 } from 'lucide-react';
import { get } from '@/api/client';
import { Input, DataTable, Pagination, Badge, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate, fmtDateTime, relativeTime, fmtNumber, fmtPct } from '@/lib/format';
import { cn, truncate, dotClass } from '@/lib/utils';
import { PROCESSING_COLORS } from '@/lib/statusColors';
import { SeverityBadge, EventStatusBadge, SEVERITY_COLORS, SEVERITY_LABELS } from '@/components/integrations/SeverityBadge';
import { ProcessingBadge, PROCESSING_LABELS } from '@/components/integrations/ProcessingBadge';
import { EventDrawer } from '@/components/integrations/EventDrawer';
import { SEVERITIES, PROCESSING_STATUSES, TYPE_LABELS, type EventListItem, type Integration, type Stats } from '@/components/integrations/types';

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  const cls = cn('h-4 w-4', className);
  if (type === 'prtg') return <Server className={cn(cls, 'text-sky-600')} aria-label="PRTG" />;
  if (type === 'fortisiem') return <ShieldAlert className={cn(cls, 'text-rose-600')} aria-label="FortiSIEM" />;
  return <Webhook className={cn(cls, 'text-muted')} aria-label="Webhook" />;
}

const DEFAULT_RANGE = '7';
const RANGES = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];
const TYPES = ['prtg', 'fortisiem', 'generic'];
const FILTER_KEYS = ['q', 'host', 'integrationId', 'integrationType', 'customerId', 'processingStatus', 'severity', 'unresolvedOnly'];

export function EventsTab({ integrations }: { integrations: Integration[] }) {
  const { state, set, page, pageSize, setPage } = useListState({ range: DEFAULT_RANGE });
  const customers = useCustomersLookup();
  const [selected, setSelected] = useState<string | null>(null);
  const severities = state.severity ? state.severity.split(',') : [];
  const query = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000; // minute precision keeps the query key stable across renders
    const range = state.range ?? DEFAULT_RANGE;
    const from = range === 'custom' ? (state.from ? new Date(state.from).toISOString() : undefined) : new Date(now - Number(range) * 86_400_000).toISOString();
    const to = range === 'custom' && state.to ? new Date(`${state.to}T23:59:59`).toISOString() : undefined;
    return { integrationId: state.integrationId, integrationType: state.integrationType, customerId: state.customerId, severity: state.severity, processingStatus: state.processingStatus, host: state.host, q: state.q, unresolvedOnly: state.unresolvedOnly, from, to, page, pageSize };
  }, [state, page, pageSize]);
  const q = useQuery({ queryKey: ['integrations', 'events', query], queryFn: () => get<{ items: EventListItem[]; total: number }>('/integrations/events', query), placeholderData: (p) => p, refetchInterval: 15_000 });
  const statsDays = state.range === 'custom' ? 30 : Math.min(90, Math.max(1, Number(state.range ?? DEFAULT_RANGE)));
  const stats = useQuery({ queryKey: ['integrations', 'stats', statsDays, state.customerId ?? ''], queryFn: () => get<Stats>('/integrations/stats', { days: statsDays, customerId: state.customerId || undefined }), refetchInterval: 30_000, placeholderData: (p) => p });
  const clear = () => set({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), range: undefined, from: undefined, to: undefined });
  const customerItems = customers.data?.items ?? [];
  const range = state.range ?? DEFAULT_RANGE;
  const st = stats.data;

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.host) addApplied('host', `Host: ${state.host}`);
  if (state.integrationId) addApplied('integrationId', `Integration: ${integrations.find((i) => i.id === state.integrationId)?.name ?? '…'}`);
  if (state.integrationType) addApplied('integrationType', `Type: ${TYPE_LABELS[state.integrationType] ?? state.integrationType}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (severities.length) addApplied('severity', `Severity: ${severities.map((sv) => SEVERITY_LABELS[sv] ?? sv).join(', ')}`);
  if (state.processingStatus) addApplied('processingStatus', `Processing: ${PROCESSING_LABELS[state.processingStatus] ?? state.processingStatus}`);
  if (state.unresolvedOnly) addApplied('unresolvedOnly', 'Needs customer');
  if (range !== DEFAULT_RANGE) addApplied('range', range === 'custom' ? `Period: ${state.from ? fmtDate(state.from) : '…'} – ${state.to ? fmtDate(state.to) : '…'}` : `Period: ${RANGES.find((r) => r.value === range)?.label.toLowerCase() ?? range}`, ['range', 'from', 'to']);
  const total = q.data?.total;

  const columns: Column<EventListItem>[] = [
    { key: 'receivedAt', header: 'Received', width: '120px', render: (r) => <span title={fmtDateTime(r.receivedAt)} className="text-muted whitespace-nowrap">{relativeTime(r.receivedAt)}</span> },
    { key: 'type', header: '', width: '28px', render: (r) => <TypeIcon type={r.integrationType} /> },
    { key: 'severity', header: 'Severity', width: '96px', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'host', header: 'Host / IP', render: (r) => (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-[180px]">{r.host ?? r.ipAddress ?? <span className="text-subtle">—</span>}</div>
        {r.host && r.ipAddress && <div className="text-xs text-subtle font-mono">{r.ipAddress}</div>}
      </div>
    ) },
    { key: 'sensor', header: 'Sensor / rule', render: (r) => <span className="text-muted truncate block max-w-[160px]" title={r.sensor ?? ''}>{r.sensor ?? '—'}</span> },
    { key: 'message', header: 'Message', render: (r) => (
      <div className="min-w-0 max-w-[360px]">
        <div className="truncate" title={r.message ?? ''}>{truncate(r.message, 90)}</div>
        <div className="text-xs text-subtle truncate flex items-center gap-1.5">{r.eventType}{r.status && <EventStatusBadge status={r.status} className="py-0 text-[10.5px]" />}</div>
      </div>
    ) },
    { key: 'customer', header: 'Customer', render: (r) => (r.customerName ? <span className="truncate block max-w-[160px]">{r.customerName}</span> : <Badge color="amber">unresolved</Badge>) },
    { key: 'ci', header: 'CI', render: (r) => (r.matchedCiId ? <Link to={`/cmdb/cis/${r.matchedCiId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline truncate block max-w-[140px]">{r.ciName ?? 'CI'}</Link> : <span className="text-subtle">—</span>) },
    { key: 'ticket', header: 'Ticket', render: (r) => (r.ticketId ? <Link to={`/tickets/${r.ticketId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline font-mono text-xs">{r.ticketNumber}</Link> : <span className="text-subtle">—</span>) },
    { key: 'processingStatus', header: 'Processing', width: '130px', render: (r) => <ProcessingBadge status={r.processingStatus} title={r.processingNote} /> },
  ];

  const rail = (
    <>
      <FilterGroup label="Source">
        <FilterSelect value={state.integrationId ?? ''} onChange={(e) => set({ integrationId: e.target.value })} placeholder="All integrations" options={integrations.map((i) => ({ value: i.id, label: i.name }))} aria-label="Integration" />
        <FilterOptions options={TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t, count: st ? st.byType?.[t] ?? 0 : undefined }))} value={state.integrationType} onChange={(v) => set({ integrationType: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Severity">
        <FilterOptions multi options={SEVERITIES.map((sv) => ({ value: sv, label: SEVERITY_LABELS[sv], dot: dotClass(SEVERITY_COLORS[sv]), count: st ? st.bySeverity?.[sv] ?? 0 : undefined }))} value={severities} onChange={(v) => set({ severity: (v as string[] | undefined)?.join(',') || undefined })} />
      </FilterGroup>
      <FilterGroup label="Processing">
        <FilterOptions options={PROCESSING_STATUSES.map((p) => ({ value: p, label: PROCESSING_LABELS[p], dot: dotClass(PROCESSING_COLORS[p]) }))} value={state.processingStatus} onChange={(v) => set({ processingStatus: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Host">
        <Input className="h-8 py-0 text-[12.5px]" placeholder="Host or IP" value={state.host ?? ''} onChange={(e) => set({ host: e.target.value })} aria-label="Host or IP" />
      </FilterGroup>
      {range === 'custom' && (
        <FilterGroup label="Custom range">
          <FilterDateRange from={state.from} to={state.to} onChange={(r) => set({ from: r.from, to: r.to })} />
        </FilterGroup>
      )}
      <FilterGroup label="More">
        <FilterToggle
          label={
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Needs customer
            </span>
          }
          hint="Events no customer mapping matched"
          checked={!!state.unresolvedOnly}
          onChange={(v) => set({ unresolvedOnly: v ? 'true' : undefined })}
        />
      </FilterGroup>
    </>
  );

  return (
    <ListShell
      id="integration-events"
      search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search message, host, sensor, id…' }}
      filters={rail}
      applied={applied}
      activeCount={applied.length}
      onClear={clear}
      count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'event' : 'events'}` : undefined}
      quick={<Segmented size="sm" options={RANGES.map((r) => ({ value: r.value, label: r.value === 'custom' ? 'Custom' : r.label }))} value={range} onChange={(v) => set({ range: v === DEFAULT_RANGE ? undefined : v })} />}
      insights={
        <InsightBand
          id="events"
          loading={stats.isLoading}
          summary={st ? `${fmtNumber(st.total)} events in the last ${statsDays} day${statsDays === 1 ? '' : 's'}` : undefined}
          kpis={
            st
              ? [
                  { label: 'Events received', value: fmtNumber(st.total), icon: <Activity className="h-4 w-4" />, hint: `${fmtNumber(st.activeIntegrations)} active integrations`, spark: st.byDay.map((d) => d.total), sparkLabel: 'Events per day' },
                  { label: 'Tickets created', value: fmtNumber(st.ticketsCreated), icon: <Ticket className="h-4 w-4" />, hint: `${fmtNumber(st.openTickets)} still open`, spark: st.byDay.map((d) => d.ticketsCreated), sparkLabel: 'Tickets created per day' },
                  { label: 'Deduplicated', value: fmtNumber(st.deduplicated), tone: 'good', icon: <Copy className="h-4 w-4" />, hint: `${fmtPct(st.dedupRate, 0)} of events folded into existing tickets` },
                  { label: 'Needs attention', value: fmtNumber(st.errors + st.unresolvedCustomer), tone: st.errors + st.unresolvedCustomer > 0 ? 'warn' : 'good', icon: <Building2 className="h-4 w-4" />, hint: `${fmtNumber(st.unresolvedCustomer)} without a customer · ${fmtNumber(st.errors)} errors`, onClick: () => set({ unresolvedOnly: state.unresolvedOnly ? undefined : 'true' }) },
                ]
              : []
          }
          panels={
            st && (
              <>
                <Panel title="Events per day" subtitle="Received events and tickets they created">
                  <TrendChart data={st.byDay} x="day" series={[{ key: 'total', label: 'Events', color: '#2563eb' }, { key: 'ticketsCreated', label: 'Tickets created', color: '#f97316' }]} kind="area" height={180} />
                </Panel>
                <Panel title="By severity" subtitle="Click to filter">
                  <BreakdownBar dense items={SEVERITIES.map((sv) => ({ label: SEVERITY_LABELS[sv], value: st.bySeverity?.[sv] ?? 0, color: SEVERITY_COLORS[sv], active: severities.length === 1 && severities[0] === sv })).filter((i) => i.value > 0)} onSelect={(i) => { const sv = SEVERITIES.find((x) => SEVERITY_LABELS[x] === i.label); if (sv) set({ severity: severities.length === 1 && severities[0] === sv ? undefined : sv }); }} />
                </Panel>
              </>
            )
          }
        />
      }
    >
      <div className="card overflow-hidden">
        <DataTable<EventListItem> columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} onRowClick={(r) => setSelected(r.id)} dense rowClassName={(r) => (r.processingStatus === 'error' ? 'row-rail-bad' : !r.customerName ? 'row-rail-warn' : undefined)} empty={<div className="py-10 text-center text-muted text-[13px]">No events in this range. {integrations.length === 0 ? 'Create an integration and point PRTG / FortiSIEM at its webhook URL.' : ''}</div>} />
        <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
      <EventDrawer id={selected} onClose={() => setSelected(null)} />
    </ListShell>
  );
}
