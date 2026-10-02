import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Ticket } from 'lucide-react';
import { PageHeader, Button, SearchInput, Select, Toggle, DataTable, Pagination, EmptyState, ErrorBlock, FilterChip, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { StatusChips } from '@/components/portal/StatusChips';
import { TicketCard, TicketSla } from '@/components/portal/TicketCard';
import { portalApi, pk, type PortalTicketRow, type StatusChip } from '@/components/portal/api';

const TYPE_OPTIONS = [
  { value: 'incident', label: 'Issues' },
  { value: 'request', label: 'Requests' },
];

export default function PortalTicketsPage() {
  const navigate = useNavigate();
  const { state, set, page, setPage } = useListState({ status: 'open' });
  const status = (state.status as StatusChip) || 'open';
  const params = useMemo(() => ({ status, type: state.type || undefined, q: state.q || undefined, siteId: state.siteId || undefined, priority: state.priority || undefined, mine: state.mine === 'true' ? 'true' : undefined, page, pageSize: 25 }), [status, state.type, state.q, state.siteId, state.priority, state.mine, page]);
  const list = useQuery({ queryKey: pk.tickets(params), queryFn: () => portalApi.tickets(params), placeholderData: (prev) => prev, refetchInterval: 60_000 });
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });

  const columns: Column<PortalTicketRow>[] = [
    { key: 'number', header: 'Ticket', width: '130px', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
    { key: 'title', header: 'Summary', render: (r) => (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-[460px]">{r.title}</div>
        <div className="text-[11.5px] text-muted flex items-center gap-1.5">
          <TypeBadge type={r.type} short className="px-1 py-0 text-[10px]" />
          {r.requesterName && <span>{r.isMine ? 'Raised by you' : `Raised by ${r.requesterName}`}</span>}
          {r.assigneeName && <span>· Engineer: {r.assigneeName}</span>}
        </div>
      </div>
    ) },
    { key: 'status', header: 'Status', width: '150px', render: (r) => <TicketStatusBadge status={r.status} /> },
    { key: 'priority', header: 'Priority', width: '110px', render: (r) => <PriorityBadge priority={r.priority} compact /> },
    { key: 'site', header: 'Site', width: '150px', render: (r) => <span className="text-[12.5px]">{r.siteName ?? '—'}</span> },
    { key: 'updated', header: 'Updated', width: '120px', render: (r) => <span className="text-[12.5px] text-muted" title={fmtDateTime(r.lastActivityAt)}>{relativeTime(r.lastActivityAt)}</span> },
    { key: 'sla', header: 'Target', width: '130px', render: (r) => <TicketSla row={r} /> },
  ];

  const items = list.data?.items ?? [];
  const empty = (
    <EmptyState
      icon={<Ticket className="h-5 w-5" />}
      title={status === 'awaiting' ? 'Nothing is waiting on you' : status === 'open' ? 'No open tickets' : 'No tickets here'}
      description={status === 'open' ? 'Everything is in hand. Raise a ticket if something needs our attention.' : 'Try another filter or clear the search.'}
      action={status === 'open' ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Raise a ticket</Button> : undefined}
    />
  );

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="My tickets"
        subtitle={me.data ? `${me.data.customer.name} · issues and requests raised with your service desk` : 'Issues and requests raised with your service desk'}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>
            New ticket
          </Button>
        }
      />
      <StatusChips value={status} onChange={(v) => set({ status: v })} counts={list.data?.counts} className="mb-3" />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SearchInput value={state.q ?? ''} onChange={(q) => set({ q })} placeholder="Search by number or words in the title…" className="w-full sm:w-72" />
        <Select value={state.type ?? ''} onChange={(e) => set({ type: e.target.value })} placeholder="Issues and requests" options={TYPE_OPTIONS} className="w-auto" />
        {(me.data?.sites.length ?? 0) > 1 && <Select value={state.siteId ?? ''} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={(me.data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))} className="w-auto" />}
        <Toggle checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined })} label="Raised by me" />
        {state.priority && (
          <FilterChip active onClick={() => set({ priority: undefined })}>
            Priority {state.priority.toUpperCase()} ×
          </FilterChip>
        )}
      </div>

      {list.isError ? (
        <ErrorBlock error={list.error} retry={() => list.refetch()} />
      ) : (
        <>
          {/* cards on small screens, table on larger ones */}
          <div className="md:hidden flex flex-col gap-2">
            {items.map((r) => (
              <TicketCard key={r.id} row={r} />
            ))}
            {!list.isLoading && items.length === 0 && <div className="card">{empty}</div>}
          </div>
          <div className="hidden md:block card">
            <DataTable columns={columns} rows={items} loading={list.isLoading} empty={empty} onRowClick={(r) => navigate(`/portal/tickets/${r.id}`)} />
            <Pagination page={page} pageSize={list.data?.pageSize ?? 25} total={list.data?.total ?? 0} onPage={setPage} />
          </div>
          <div className="md:hidden">
            <Pagination page={page} pageSize={list.data?.pageSize ?? 25} total={list.data?.total ?? 0} onPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
}
