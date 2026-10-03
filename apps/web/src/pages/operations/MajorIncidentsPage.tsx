import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Flame, PhoneCall, AlertTriangle, ClipboardList, CheckCircle2, Siren } from 'lucide-react';
import { PageHeader, DataTable, Pagination, EmptyState, ErrorBlock, Badge, StatTile, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { OPERATIONS_MODULES } from '@/layouts/modules';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ticketsApi, qk } from '@/components/tickets/api';
import { TicketStatusBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { MAJOR_STATUS_LABELS, type MajorListRow, type MajorStatus } from '@/components/tickets/types';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'resolved', label: 'Resolved · review pending' },
  { value: 'review_done', label: 'Review complete' },
  { value: 'demoted', label: 'Demoted' },
  { value: 'all', label: 'Everything' },
];
const STATUS_COLOR: Record<MajorStatus, string> = { active: 'red', resolved: 'amber', review_done: 'green', demoted: 'slate' };

/** Minutes until (positive) or since (negative) an ISO time. */
const minutesTo = (iso: string | null) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 60_000) : null);

/**
 * Every major incident across the customers the viewer can see: who commands it, when the
 * stakeholders last heard from us and when they are owed the next update.
 */
export default function MajorIncidentsPage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize } = useListState({ status: 'active', pageSize: '25' });
  const customers = useCustomersLookup();
  const params = useMemo(() => ({ status: state.status || 'active', customerId: state.customerId || undefined, q: state.q || undefined, page, pageSize }), [state.status, state.customerId, state.q, page, pageSize]);
  const q = useQuery({ queryKey: qk.majorList(params), queryFn: () => ticketsApi.majorList(params), refetchInterval: 60_000, placeholderData: (p) => p });
  const data = q.data;
  const summary = data?.summary;
  const rows = useMemo(() => (data?.items ?? []).map((r) => ({ ...r, id: r.ticketId })), [data]);
  const customerItems = customers.data?.items ?? [];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.status && state.status !== 'active') addApplied('status', `Status: ${STATUS_OPTIONS.find((s) => s.value === state.status)?.label ?? state.status}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);

  const columns: Column<MajorListRow & { id: string }>[] = [
    { key: 'number', header: 'Ticket', width: '120px', render: (r) => <Link to={`/tickets/${r.ticketId}?tab=major`} className="font-mono text-[12.5px] text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>{r.number}</Link> },
    {
      key: 'title',
      header: 'Incident',
      width: '100%',
      render: (r) => (
        <div className="min-w-0" style={{ width: 0, minWidth: '100%' }}>
          <div className="font-medium truncate" title={r.title}>{r.title}</div>
          <div className="text-[11.5px] text-muted truncate">
            {r.customerName} · declared <span title={fmtDateTime(r.declaredAt)}>{relativeTime(r.declaredAt)}</span>
            {r.childrenCount > 0 && ` · ${r.childrenCount} child${r.childrenCount === 1 ? '' : 'ren'}`}
          </div>
        </div>
      ),
    },
    { key: 'priority', header: 'Priority', width: '84px', render: (r) => <PriorityBadge priority={r.priority} compact /> },
    { key: 'state', header: 'State', width: '170px', render: (r) => <div className="flex flex-col gap-1 items-start"><Badge color={STATUS_COLOR[r.status]}>{MAJOR_STATUS_LABELS[r.status]}</Badge><TicketStatusBadge status={r.ticketStatus} /></div> },
    { key: 'commander', header: 'Commander', width: '140px', render: (r) => <div className="min-w-0 text-[12.5px]"><div className="truncate">{r.commanderName ?? <span className="text-muted">Not set</span>}</div>{r.commsLeadName && <div className="text-[11.5px] text-muted truncate">Comms: {r.commsLeadName}</div>}</div> },
    {
      key: 'updates',
      header: 'Stakeholder updates',
      width: '190px',
      render: (r) => {
        const due = r.status === 'active' ? minutesTo(r.nextUpdateDueAt) : null;
        return (
          <div className="text-[12.5px] min-w-0">
            <div className="tnum truncate">{r.updatesCount} sent{r.lastUpdateAt ? <span className="text-muted"> · last {relativeTime(r.lastUpdateAt)}</span> : <span className="text-muted"> · none yet</span>}</div>
            {due !== null ? (
              <div className={cn('text-[11.5px] inline-flex items-center gap-1 truncate max-w-full', due < 0 ? 'text-red-600 font-medium' : due < 10 ? 'text-amber-600' : 'text-muted')} title={r.nextUpdateDueAt ? fmtDateTime(r.nextUpdateDueAt) : undefined}>
                {due < 0 && <AlertTriangle className="h-3 w-3 shrink-0" />}
                {due < 0 ? `next ${fmtDuration(-due)} overdue` : `next in ${fmtDuration(due)}`}
              </div>
            ) : r.status === 'active' ? (
              <div className="text-[11.5px] text-muted">no cadence set</div>
            ) : null}
          </div>
        );
      },
    },
    { key: 'bridge', header: '', width: '72px', render: (r) => (r.bridgeUrl && r.status === 'active' ? <a href={r.bridgeUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-[12px] text-red-700 hover:underline" title="Join the bridge"><PhoneCall className="h-3.5 w-3.5" /> Bridge</a> : null) },
  ];

  const filters = (
    <>
      <FilterGroup label="State">
        <FilterOptions options={STATUS_OPTIONS} value={state.status || 'active'} onChange={(v) => set({ status: (v as string | undefined) ?? 'active' })} />
      </FilterGroup>
      <FilterGroup label="Customer" defaultOpen={!!state.customerId}>
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Major incidents" subtitle="Outages run as a programme: a bridge, a commander, updates on a cadence and a review afterwards" />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <ListShell
        id="major-incidents"
        modules={OPERATIONS_MODULES}
        filters={filters}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Ticket number or title…' }}
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ status: undefined, customerId: undefined, q: undefined })}
        insights={
          summary && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatTile label="Active now" value={summary.active} tone={summary.active ? 'bad' : 'good'} icon={<Flame className="h-4 w-4" />} onClick={() => set({ status: 'active' })} />
              <StatTile label="Update overdue" value={summary.overdue} tone={summary.overdue ? 'bad' : 'default'} icon={<AlertTriangle className="h-4 w-4" />} hint="stakeholders waiting" />
              <StatTile label="Awaiting review" value={summary.awaitingReview} tone={summary.awaitingReview ? 'warn' : 'default'} icon={<ClipboardList className="h-4 w-4" />} onClick={() => set({ status: 'resolved' })} hint="resolved, no post-incident review yet" />
              <StatTile label="Resolved · 30 days" value={summary.resolved30d} icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => set({ status: 'all' })} />
            </div>
          )
        }
        count={data ? `${data.total} major incident${data.total === 1 ? '' : 's'}` : undefined}
      >
        <div className="card overflow-x-auto">
          <DataTable
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            dense
            onRowClick={(r) => navigate(`/tickets/${r.ticketId}?tab=major`)}
            rowClassName={(r) => (r.overdue ? 'shadow-[inset_3px_0_0_0_var(--color-red-500)]' : undefined)}
            empty={<EmptyState icon={<Siren className="h-5 w-5" />} title={state.status === 'active' || !state.status ? 'No major incidents in progress' : 'Nothing here'} description="Declare one from an incident's actions menu when an outage needs a bridge, a commander and regular stakeholder updates." />}
          />
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p }, false)} />}
        </div>
      </ListShell>
    </div>
  );
}
