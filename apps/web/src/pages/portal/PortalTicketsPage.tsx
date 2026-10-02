import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Ticket } from 'lucide-react';
import { PageHeader, Button, DataTable, Pagination, EmptyState, ErrorBlock, ListShell, FilterGroup, FilterOptions, FilterDateRange, FilterToggle, type Column, type AppliedFilter } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { PRIORITY_LEVEL_COLORS, TICKET_TYPE_COLORS } from '@/lib/statusColors';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { StatusChips } from '@/components/portal/StatusChips';
import { TicketCard, TicketSla } from '@/components/portal/TicketCard';
import { portalApi, pk, type PortalTicketRow, type StatusChip } from '@/components/portal/api';

const TYPE_OPTIONS = [
  { value: 'incident', label: 'Issues' },
  { value: 'request', label: 'Requests' },
];
const FALLBACK_PRIORITIES = [1, 2, 3, 4, 5].map((n) => ({ key: `p${n}`, label: `P${n}`, level: n }));
const FILTER_KEYS = ['q', 'type', 'siteId', 'priority', 'mine', 'createdFrom', 'createdTo'];

export default function PortalTicketsPage() {
  const navigate = useNavigate();
  const { state, set, page, setPage } = useListState({ status: 'open' });
  const { options } = useLookups();
  const status = (state.status as StatusChip) || 'open';
  const params = useMemo(
    () => ({ status, type: state.type || undefined, q: state.q || undefined, siteId: state.siteId || undefined, priority: state.priority || undefined, mine: state.mine === 'true' ? 'true' : undefined, createdFrom: state.createdFrom || undefined, createdTo: state.createdTo || undefined, page, pageSize: 25 }),
    [status, state.type, state.q, state.siteId, state.priority, state.mine, state.createdFrom, state.createdTo, page],
  );
  const list = useQuery({ queryKey: pk.tickets(params), queryFn: () => portalApi.tickets(params), placeholderData: (prev) => prev, refetchInterval: 60_000 });
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const sites = me.data?.sites ?? [];

  /** P1…P5 from the configured priorities (key, label, level), with a plain fallback before the lookups load. */
  const priorities = useMemo(() => {
    const configured = options('ticket_priority')
      .filter((o) => /^p\d$/i.test(o.key))
      .map((o) => ({ key: o.key.toLowerCase(), label: o.label, level: o.level ?? Number(o.key.slice(1)) }))
      .sort((a, b) => a.level - b.level);
    return configured.length ? configured : FALLBACK_PRIORITIES;
  }, [options]);

  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.type) applied.push({ key: 'type', label: TYPE_OPTIONS.find((t) => t.value === state.type)?.label ?? state.type, onRemove: () => set({ type: undefined }) });
  if (state.siteId) applied.push({ key: 'siteId', label: `Site: ${sites.find((s) => s.id === state.siteId)?.name ?? '…'}`, onRemove: () => set({ siteId: undefined }) });
  if (state.priority) applied.push({ key: 'priority', label: `Priority: ${priorities.find((p) => p.key === state.priority.toLowerCase())?.label ?? state.priority.toUpperCase()}`, onRemove: () => set({ priority: undefined }) });
  if (state.mine === 'true') applied.push({ key: 'mine', label: 'Raised by me', onRemove: () => set({ mine: undefined }) });
  if (state.createdFrom || state.createdTo) applied.push({ key: 'created', label: `Created ${state.createdFrom ? `from ${fmtDate(state.createdFrom)}` : ''}${state.createdFrom && state.createdTo ? ' ' : ''}${state.createdTo ? `to ${fmtDate(state.createdTo)}` : ''}`, onRemove: () => set({ createdFrom: undefined, createdTo: undefined }) });

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
      description={status === 'open' && activeCount === 0 ? 'Everything is in hand. Raise a ticket if something needs our attention.' : 'Try another filter or clear the search.'}
      action={status === 'open' && activeCount === 0 ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Raise a ticket</Button> : undefined}
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
      <ListShell
        id="portal-tickets"
        search={{ value: state.q ?? '', onChange: (q) => set({ q }), placeholder: 'Search by number or words in the title…' }}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} ${list.data.total === 1 ? 'ticket' : 'tickets'}` : undefined}
        quick={<StatusChips value={status} onChange={(v) => set({ status: v })} counts={list.data?.counts} />}
        filters={
          <>
            <FilterGroup label="Type">
              <FilterOptions options={TYPE_OPTIONS.map((t) => ({ ...t, dot: dotClass(TICKET_TYPE_COLORS[t.value]) }))} value={state.type} onChange={(v) => set({ type: v as string | undefined })} />
            </FilterGroup>
            {sites.length > 1 && (
              <FilterGroup label="Site">
                <FilterOptions options={sites.map((s) => ({ value: s.id, label: s.name }))} value={state.siteId} onChange={(v) => set({ siteId: v as string | undefined })} />
              </FilterGroup>
            )}
            <FilterGroup label="Priority">
              <FilterOptions options={priorities.map((p) => ({ value: p.key, label: p.label, dot: dotClass(PRIORITY_LEVEL_COLORS[p.level] ?? 'slate') }))} value={state.priority?.toLowerCase()} onChange={(v) => set({ priority: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Raised by">
              <FilterToggle label="Raised by me" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined })} />
            </FilterGroup>
            <FilterGroup label="Created" defaultOpen={!!(state.createdFrom || state.createdTo)}>
              <FilterDateRange from={state.createdFrom} to={state.createdTo} onChange={(r) => set({ createdFrom: r.from, createdTo: r.to })} />
            </FilterGroup>
          </>
        }
      >
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
      </ListShell>
    </div>
  );
}
