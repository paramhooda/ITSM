import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, ShieldAlert, Webhook, AlertTriangle } from 'lucide-react';
import { get } from '@/api/client';
import { Select, SearchInput, Input, DataTable, Pagination, Button, Badge, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn, truncate, colorClass } from '@/lib/utils';
import { SeverityBadge, SEVERITY_COLORS, SEVERITY_LABELS } from '@/components/integrations/SeverityBadge';
import { ProcessingBadge, PROCESSING_LABELS } from '@/components/integrations/ProcessingBadge';
import { EventDrawer } from '@/components/integrations/EventDrawer';
import { SEVERITIES, PROCESSING_STATUSES, type EventListItem, type Integration } from '@/components/integrations/types';

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
    const now = Date.now();
    const range = state.range ?? '7';
    const from = range === 'custom' ? (state.from ? new Date(state.from).toISOString() : undefined) : new Date(now - Number(range) * 86_400_000).toISOString();
    const to = range === 'custom' && state.to ? new Date(`${state.to}T23:59:59`).toISOString() : undefined;
    return { integrationId: state.integrationId, integrationType: state.integrationType, customerId: state.customerId, severity: state.severity, processingStatus: state.processingStatus, host: state.host, q: state.q, unresolvedOnly: state.unresolvedOnly, from, to, page, pageSize };
  }, [state, page, pageSize]);
  const q = useQuery({ queryKey: ['integrations', 'events', query], queryFn: () => get<{ items: EventListItem[]; total: number }>('/integrations/events', query), placeholderData: (p) => p, refetchInterval: 15_000 });

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
        <div className="text-xs text-subtle truncate">{r.eventType}{r.status ? ` · ${r.status}` : ''}</div>
      </div>
    ) },
    { key: 'customer', header: 'Customer', render: (r) => (r.customerName ? <span className="truncate block max-w-[160px]">{r.customerName}</span> : <Badge color="amber">unresolved</Badge>) },
    { key: 'ci', header: 'CI', render: (r) => (r.matchedCiId ? <Link to={`/cmdb/${r.matchedCiId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline truncate block max-w-[140px]">{r.ciName ?? 'CI'}</Link> : <span className="text-subtle">—</span>) },
    { key: 'ticket', header: 'Ticket', render: (r) => (r.ticketId ? <Link to={`/tickets/${r.ticketId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline font-mono text-xs">{r.ticketNumber}</Link> : <span className="text-subtle">—</span>) },
    { key: 'processingStatus', header: 'Processing', width: '130px', render: (r) => <ProcessingBadge status={r.processingStatus} title={r.processingNote} /> },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="card p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search message, host, sensor, id…" className="w-64" />
          <Input className="w-44" placeholder="Host or IP" value={state.host ?? ''} onChange={(e) => set({ host: e.target.value })} />
          <Select className="w-44" value={state.integrationId ?? ''} onChange={(e) => set({ integrationId: e.target.value })} placeholder="All integrations" options={integrations.map((i) => ({ value: i.id, label: i.name }))} />
          <Select className="w-36" value={state.integrationType ?? ''} onChange={(e) => set({ integrationType: e.target.value })} placeholder="All types" options={[{ value: 'prtg', label: 'PRTG' }, { value: 'fortisiem', label: 'FortiSIEM' }, { value: 'generic', label: 'Webhook' }]} />
          <Select className="w-44" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Select className="w-40" value={state.processingStatus ?? ''} onChange={(e) => set({ processingStatus: e.target.value })} placeholder="Any processing" options={PROCESSING_STATUSES.map((s) => ({ value: s, label: PROCESSING_LABELS[s] }))} />
          <Select className="w-36" value={state.range ?? '7'} onChange={(e) => set({ range: e.target.value })} options={RANGES} />
          {state.range === 'custom' && (
            <>
              <Input type="date" className="w-36" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
              <Input type="date" className="w-36" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-subtle mr-1">Severity:</span>
          {SEVERITIES.map((s) => (
            <button key={s} type="button" onClick={() => toggleSeverity(s)} className={cn('rounded-md px-2 py-0.5 border transition-colors', severities.includes(s) ? cn(colorClass(SEVERITY_COLORS[s]), 'border-transparent') : 'border-default text-muted hover:bg-surface-2')}>
              {SEVERITY_LABELS[s]}
            </button>
          ))}
          <span className="mx-2 text-subtle">|</span>
          <button type="button" onClick={() => set({ unresolvedOnly: state.unresolvedOnly ? undefined : 'true' })} className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 border transition-colors', state.unresolvedOnly ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 border-transparent' : 'border-default text-muted hover:bg-surface-2')}>
            <AlertTriangle className="h-3 w-3" /> Needs customer
          </button>
          {(state.q || state.host || state.integrationId || state.integrationType || state.customerId || state.processingStatus || state.severity || state.unresolvedOnly) && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => set({ q: undefined, host: undefined, integrationId: undefined, integrationType: undefined, customerId: undefined, processingStatus: undefined, severity: undefined, unresolvedOnly: undefined })}>
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <div className="card">
        <DataTable<EventListItem> columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} onRowClick={(r) => setSelected(r.id)} dense empty={<div className="py-10 text-center text-muted text-[13px]">No events in this range. {integrations.length === 0 ? 'Create an integration and point PRTG / FortiSIEM at its webhook URL.' : ''}</div>} />
        <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
      <EventDrawer id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

