import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, ShieldAlert, Webhook, AlertTriangle, Activity, Ticket, Copy, Building2 } from 'lucide-react';
import { get } from '@/api/client';
import { Select, SearchInput, Input, DataTable, Pagination, Badge, FilterBar, FilterChip, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, relativeTime, fmtNumber, fmtPct } from '@/lib/format';
import { cn, truncate, dotClass } from '@/lib/utils';
import { SeverityBadge, EventStatusBadge, SEVERITY_COLORS, SEVERITY_LABELS } from '@/components/integrations/SeverityBadge';
import { ProcessingBadge, PROCESSING_LABELS } from '@/components/integrations/ProcessingBadge';
import { EventDrawer } from '@/components/integrations/EventDrawer';
import { SEVERITIES, PROCESSING_STATUSES, type EventListItem, type Integration, type Stats } from '@/components/integrations/types';

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  const cls = cn('h-4 w-4', className);
  if (type === 'prtg') return <Server className={cn(cls, 'text-sky-600')} aria-label="PRTG" />;
  if (type === 'fortisiem') return <ShieldAlert className={cn(cls, 'text-rose-600')} aria-label="FortiSIEM" />;
  return <Webhook className={cn(cls, 'text-muted')} aria-label="Webhook" />;
}

const RANGES = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];

export function EventsTab({ integrations }: { integrations: Integration[] }) {
  const { state, set, page, pageSize, setPage } = useListState({ range: '7' });
  const customers = useCustomersLookup();
  const [selected, setSelected] = useState<string | null>(null);
  const severities = state.severity ? state.severity.split(',') : [];
  const toggleSeverity = (s: string) => set({ severity: (severities.includes(s) ? severities.filter((x) => x !== s) : [...severities, s]).join(',') || undefined });
  const query = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000; // minute precision keeps the query key stable across renders
    const range = state.range ?? '7';
    const from = range === 'custom' ? (state.from ? new Date(state.from).toISOString() : undefined) : new Date(now - Number(range) * 86_400_000).toISOString();
    const to = range === 'custom' && state.to ? new Date(`${state.to}T23:59:59`).toISOString() : undefined;
    return { integrationId: state.integrationId, integrationType: state.integrationType, customerId: state.customerId, severity: state.severity, processingStatus: state.processingStatus, host: state.host, q: state.q, unresolvedOnly: state.unresolvedOnly, from, to, page, pageSize };
  }, [state, page, pageSize]);
  const q = useQuery({ queryKey: ['integrations', 'events', query], queryFn: () => get<{ items: EventListItem[]; total: number }>('/integrations/events', query), placeholderData: (p) => p, refetchInterval: 15_000 });
  const statsDays = state.range === 'custom' ? 30 : Math.min(90, Math.max(1, Number(state.range ?? '7')));
  const stats = useQuery({ queryKey: ['integrations', 'stats', statsDays, state.customerId ?? ''], queryFn: () => get<Stats>('/integrations/stats', { days: statsDays, customerId: state.customerId || undefined }), refetchInterval: 30_000, placeholderData: (p) => p });
  const activeCount = ['q', 'host', 'integrationId', 'integrationType', 'customerId', 'processingStatus', 'severity', 'unresolvedOnly'].filter((k) => state[k]).length;
  const clear = () => set({ q: undefined, host: undefined, integrationId: undefined, integrationType: undefined, customerId: undefined, processingStatus: undefined, severity: undefined, unresolvedOnly: undefined });

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
    { key: 'ci', header: 'CI', render: (r) => (r.matchedCiId ? <Link to={`/cmdb/${r.matchedCiId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline truncate block max-w-[140px]">{r.ciName ?? 'CI'}</Link> : <span className="text-subtle">—</span>) },
    { key: 'ticket', header: 'Ticket', render: (r) => (r.ticketId ? <Link to={`/tickets/${r.ticketId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline font-mono text-xs">{r.ticketNumber}</Link> : <span className="text-subtle">—</span>) },
    { key: 'processingStatus', header: 'Processing', width: '130px', render: (r) => <ProcessingBadge status={r.processingStatus} title={r.processingNote} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        activeCount={activeCount}
        onClear={clear}
        chips={
          <>
            {SEVERITIES.map((sv) => (
              <FilterChip key={sv} active={severities.includes(sv)} onClick={() => toggleSeverity(sv)} dot={dotClass(SEVERITY_COLORS[sv])} count={stats.data?.bySeverity?.[sv] ?? 0}>
                {SEVERITY_LABELS[sv]}
              </FilterChip>
            ))}
            <span className="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden />
            <FilterChip active={!!state.unresolvedOnly} onClick={() => set({ unresolvedOnly: state.unresolvedOnly ? undefined : 'true' })} dot={dotClass('amber')}>
              <AlertTriangle className="h-3 w-3" /> Needs customer
            </FilterChip>
          </>
        }
      >
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search message, host, sensor, id…" className="w-64" />
        <Input className="w-40 h-8 py-0 text-[13px]" placeholder="Host or IP" value={state.host ?? ''} onChange={(e) => set({ host: e.target.value })} />
        <Select className="w-44 h-8 py-0 text-[13px]" value={state.integrationId ?? ''} onChange={(e) => set({ integrationId: e.target.value })} placeholder="All integrations" options={integrations.map((i) => ({ value: i.id, label: i.name }))} />
        <Select className="w-32 h-8 py-0 text-[13px]" value={state.integrationType ?? ''} onChange={(e) => set({ integrationType: e.target.value })} placeholder="All types" options={[{ value: 'prtg', label: 'PRTG' }, { value: 'fortisiem', label: 'FortiSIEM' }, { value: 'generic', label: 'Webhook' }]} />
        <Select className="w-44 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="w-40 h-8 py-0 text-[13px]" value={state.processingStatus ?? ''} onChange={(e) => set({ processingStatus: e.target.value })} placeholder="Any processing" options={PROCESSING_STATUSES.map((st) => ({ value: st, label: PROCESSING_LABELS[st] }))} />
        <Select className="w-36 h-8 py-0 text-[13px]" value={state.range ?? '7'} onChange={(e) => set({ range: e.target.value })} options={RANGES} />
        {state.range === 'custom' && (
          <>
            <Input type="date" className="w-36 h-8 py-0 text-[13px]" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
            <Input type="date" className="w-36 h-8 py-0 text-[13px]" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
          </>
        )}
      </FilterBar>

      <InsightBand
        id="events"
        loading={stats.isLoading}
        summary={stats.data ? `${fmtNumber(stats.data.total)} events in the last ${statsDays} day${statsDays === 1 ? '' : 's'}` : undefined}
        kpis={
          stats.data
            ? [
                { label: 'Events received', value: fmtNumber(stats.data.total), icon: <Activity className="h-4 w-4" />, hint: `${fmtNumber(stats.data.activeIntegrations)} active integrations`, spark: stats.data.byDay.map((d) => d.total), sparkLabel: 'Events per day' },
                { label: 'Tickets created', value: fmtNumber(stats.data.ticketsCreated), icon: <Ticket className="h-4 w-4" />, hint: `${fmtNumber(stats.data.openTickets)} still open`, spark: stats.data.byDay.map((d) => d.ticketsCreated), sparkLabel: 'Tickets created per day' },
                { label: 'Deduplicated', value: fmtNumber(stats.data.deduplicated), tone: 'good', icon: <Copy className="h-4 w-4" />, hint: `${fmtPct(stats.data.dedupRate, 0)} of events folded into existing tickets` },
                { label: 'Needs attention', value: fmtNumber(stats.data.errors + stats.data.unresolvedCustomer), tone: stats.data.errors + stats.data.unresolvedCustomer > 0 ? 'warn' : 'good', icon: <Building2 className="h-4 w-4" />, hint: `${fmtNumber(stats.data.unresolvedCustomer)} without a customer · ${fmtNumber(stats.data.errors)} errors`, onClick: () => set({ unresolvedOnly: state.unresolvedOnly ? undefined : 'true' }) },
              ]
            : []
        }
        panels={
          stats.data && (
            <>
              <Panel title="Events per day" subtitle="Received events and tickets they created">
                <TrendChart data={stats.data.byDay} x="day" series={[{ key: 'total', label: 'Events', color: '#2563eb' }, { key: 'ticketsCreated', label: 'Tickets created', color: '#f97316' }]} kind="area" height={180} />
              </Panel>
              <Panel title="By severity" subtitle="Click to filter">
                <BreakdownBar dense items={SEVERITIES.map((sv) => ({ label: SEVERITY_LABELS[sv], value: stats.data?.bySeverity?.[sv] ?? 0, color: SEVERITY_COLORS[sv], active: severities.length === 1 && severities[0] === sv })).filter((i) => i.value > 0)} onSelect={(i) => { const sv = SEVERITIES.find((x) => SEVERITY_LABELS[x] === i.label); if (sv) set({ severity: severities.length === 1 && severities[0] === sv ? undefined : sv }); }} />
              </Panel>
            </>
          )
        }
      />

      <div className="card overflow-hidden">
        <DataTable<EventListItem> columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} onRowClick={(r) => setSelected(r.id)} dense rowClassName={(r) => (r.processingStatus === 'error' ? 'row-rail-bad' : !r.customerName ? 'row-rail-warn' : undefined)} empty={<div className="py-10 text-center text-muted text-[13px]">No events in this range. {integrations.length === 0 ? 'Create an integration and point PRTG / FortiSIEM at its webhook URL.' : ''}</div>} />
        <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
      <EventDrawer id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

