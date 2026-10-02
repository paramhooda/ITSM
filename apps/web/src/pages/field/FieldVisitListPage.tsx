import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, CalendarDays, List as ListIcon, Clock, Wrench, BadgeCheck, Hourglass } from 'lucide-react';
import { PageHeader, Button, DataTable, Pagination, Avatar, FilterChip, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle, type Column, type AppliedFilter } from '@/components/ui';
import { FIELD_MODULES } from '@/layouts/modules';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList, Segmented } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useSites } from '@/components/cmdb/hooks';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, fmtDate, fmtNumber, fmtDuration } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { VISIT_STATUS_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { fieldApi, fieldKeys } from '@/components/field/api';
import { VisitStatusBadge } from '@/components/field/VisitStatusBadge';
import { VisitForm } from '@/components/field/VisitForm';
import { ymd } from '@/components/field/VisitCalendar';
import { STATUS_LABELS, VISIT_STATUSES, type VisitListRow, type VisitStatus } from '@/components/field/types';

const FILTER_KEYS = ['q', 'customerId', 'siteId', 'status', 'engineerId', 'teamId', 'typeId', 'from', 'to', 'mine', 'unassigned', 'overdue', 'unacknowledged'];
const DEFAULTS = { status: 'requested,scheduled,in_progress', sort: 'scheduledStart', order: 'asc' };

/** Visits module of Field Service: the filterable list (the week grid lives on /field/calendar). */
export default function FieldVisitListPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const sites = useSites(state.customerId);
  const can = useAuthStore((s) => s.can);
  const [createOpen, setCreateOpen] = useState(false);

  // `?view=calendar` used to switch this page into the week grid; it is its own module now.
  const toCalendar = state.view === 'calendar';
  useEffect(() => {
    if (!toCalendar) return;
    const sp = new URLSearchParams(location.search);
    sp.delete('view');
    const qs = sp.toString();
    navigate(`/field/calendar${qs ? `?${qs}` : ''}`, { replace: true });
  }, [toCalendar, location.search, navigate]);

  const params = useMemo(() => {
    const p: Record<string, unknown> = { page, pageSize, sort: state.sort, order: state.order };
    for (const k of ['q', 'customerId', 'siteId', 'status', 'engineerId', 'teamId', 'typeId', 'from', 'to'] as const) if (state[k]) p[k] = state[k];
    for (const k of ['mine', 'unacknowledged', 'unassigned', 'overdue'] as const) if (state[k] === 'true') p[k] = 'true';
    return p;
  }, [state, page, pageSize]);
  const list = useQuery({ queryKey: fieldKeys.list(params), queryFn: () => fieldApi.list(params), placeholderData: (prev) => prev, enabled: !toCalendar });
  const summaryParams = useMemo(() => (state.customerId ? { customerId: state.customerId } : {}), [state.customerId]);
  const summary = useQuery({ queryKey: fieldKeys.summary(summaryParams), queryFn: () => fieldApi.summary(summaryParams), refetchInterval: 60_000 });

  const statuses = (state.status ?? '').split(',').filter(Boolean);
  const toggleStatus = (key: string) => set({ status: (statuses.includes(key) ? statuses.filter((s) => s !== key) : [...statuses, key]).join(',') });
  const activeFilterCount = ['q', 'customerId', 'siteId', 'engineerId', 'teamId', 'typeId', 'from', 'to', 'mine', 'unassigned', 'overdue', 'unacknowledged'].filter((k) => state[k]).length + (state.status !== DEFAULTS.status ? 1 : 0);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const teams = lookups?.teams ?? [];
  const visitTypes = options('field_visit_type');
  const nameOf = <T extends { id: string }>(rows: T[] | undefined, id: string | undefined, pick: (r: T) => string) => (id ? pick(rows?.find((r) => r.id === id) ?? ({} as T)) || '…' : '');

  const applied: AppliedFilter[] = [];
  if (state.status !== DEFAULTS.status) applied.push({ key: 'status', label: `Status: ${statuses.map((s) => STATUS_LABELS[s as VisitStatus] ?? s).join(', ') || 'any'}`, onRemove: () => set({ status: undefined }) });
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.customerId) applied.push({ key: 'customerId', label: `Customer: ${nameOf(customerItems, state.customerId, (c) => c.name)}`, onRemove: () => set({ customerId: undefined, siteId: undefined }) });
  if (state.siteId) applied.push({ key: 'siteId', label: `Site: ${nameOf(sites.data, state.siteId, (s) => s.name)}`, onRemove: () => set({ siteId: undefined }) });
  if (state.engineerId) applied.push({ key: 'engineerId', label: `Engineer: ${nameOf(engineers.data, state.engineerId, (u) => u.name)}`, onRemove: () => set({ engineerId: undefined }) });
  if (state.teamId) applied.push({ key: 'teamId', label: `Team: ${nameOf(teams, state.teamId, (t) => t.name)}`, onRemove: () => set({ teamId: undefined }) });
  if (state.typeId) applied.push({ key: 'typeId', label: `Type: ${nameOf(visitTypes, state.typeId, (o) => o.label)}`, onRemove: () => set({ typeId: undefined }) });
  if (state.from || state.to) applied.push({ key: 'dates', label: `Scheduled ${state.from ? `from ${fmtDate(state.from)}` : ''}${state.from && state.to ? ' ' : ''}${state.to ? `to ${fmtDate(state.to)}` : ''}`, onRemove: () => set({ from: undefined, to: undefined }) });
  if (state.mine === 'true') applied.push({ key: 'mine', label: 'Assigned to me', onRemove: () => set({ mine: undefined }) });
  if (state.unassigned === 'true') applied.push({ key: 'unassigned', label: 'Unassigned', onRemove: () => set({ unassigned: undefined }) });
  if (state.overdue === 'true') applied.push({ key: 'overdue', label: 'Overdue', onRemove: () => set({ overdue: undefined }) });
  if (state.unacknowledged === 'true') applied.push({ key: 'unacknowledged', label: 'Awaiting acknowledgement', onRemove: () => set({ unacknowledged: undefined }) });

  const columns: Column<VisitListRow>[] = [
    { key: 'number', header: 'Visit', sortable: true, width: '110px', render: (r) => <Link to={`/field/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12.5px] font-medium text-brand-700 hover:underline">{r.number}</Link> },
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      render: (r) => (
        <div className="min-w-[220px] max-w-[480px]">
          <div className="truncate font-medium text-[13.5px]">{r.title}</div>
          <div className="text-[11.5px] text-muted truncate">
            {r.customerName ?? '—'}
            {r.siteName ? ` · ${r.siteName}` : ''}
            {r.pmProgramName ? ` · PM: ${r.pmProgramName}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', width: '150px', render: (r) => <span className="text-[13px]">{r.typeLabel ?? '—'}</span> },
    {
      key: 'scheduledStart',
      header: 'Scheduled',
      sortable: true,
      width: '170px',
      render: (r) => (
        <div className="text-[12.5px] whitespace-nowrap">
          <div>{r.scheduledStart ? fmtDateTime(r.scheduledStart) : <span className="text-subtle">Not scheduled</span>}</div>
          {r.status === 'completed' && r.actualEnd && <div className="text-[11px] text-muted">done {fmtDate(r.actualEnd)}</div>}
        </div>
      ),
    },
    {
      key: 'engineer',
      header: 'Engineer',
      sortable: true,
      width: '170px',
      render: (r) =>
        r.engineerName ? (
          <div className="flex items-center gap-2 min-w-0"><Avatar name={r.engineerName} size="xs" /><span className="truncate text-[13px]">{r.engineerName}</span>{(r.additionalEngineers?.length ?? 0) > 0 && <span className="text-[11px] text-subtle">+{r.additionalEngineers!.length}</span>}</div>
        ) : (
          <span className="text-[12.5px] text-subtle">{r.teamName ? `${r.teamName} · unassigned` : 'Unassigned'}</span>
        ),
    },
    { key: 'status', header: 'Status', sortable: true, width: '130px', render: (r) => <VisitStatusBadge status={r.status} /> },
    { key: 'ticket', header: 'Ticket', width: '110px', render: (r) => (r.ticketId ? <Link to={`/tickets/${r.ticketId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12px] text-brand-700 hover:underline">{r.ticketNumber}</Link> : <span className="text-subtle">—</span>) },
    { key: 'ack', header: 'Ack', width: '60px', render: (r) => (r.customerAckAt ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label={`Acknowledged by ${r.customerAckName}`} /> : r.status === 'completed' ? <Hourglass className="h-4 w-4 text-amber-500" aria-label="Pending acknowledgement" /> : <span className="text-subtle">—</span>) },
  ];

  const tiles = summary.data?.tiles;

  const filters = (
    <>
      <FilterGroup label="Status">
        <FilterOptions multi options={VISIT_STATUSES.map((st: VisitStatus) => ({ value: st, label: STATUS_LABELS[st], dot: dotClass(VISIT_STATUS_COLORS[st]), count: summary.data?.byStatus?.[st] ?? 0 }))} value={statuses} onChange={(v) => set({ status: Array.isArray(v) ? v.join(',') : v })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Site">
        <FilterSelect value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder={state.customerId ? 'All sites' : 'Choose a customer first'} options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </FilterGroup>
      <FilterGroup label="Engineer">
        <FilterSelect value={state.engineerId ?? ''} onChange={(e) => set({ engineerId: e.target.value, mine: undefined, unassigned: undefined })} placeholder="Any engineer" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        <FilterSelect value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Any team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
        <FilterToggle label="Assigned to me" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined, engineerId: undefined, unassigned: undefined })} />
        <FilterToggle label="Unassigned" hint="No engineer assigned yet" checked={state.unassigned === 'true'} onChange={(v) => set({ unassigned: v ? 'true' : undefined, engineerId: undefined, mine: undefined })} />
      </FilterGroup>
      {visitTypes.length > 0 && (
        <FilterGroup label="Type" defaultOpen={!!state.typeId}>
          <FilterOptions options={visitTypes.map((o) => ({ value: o.id, label: o.label, count: summary.data?.byType.find((t) => t.typeId === o.id)?.count ?? null }))} value={state.typeId} onChange={(v) => set({ typeId: v as string | undefined })} />
        </FilterGroup>
      )}
      <FilterGroup label="Scheduled">
        <FilterDateRange from={state.from} to={state.to} onChange={(r) => set({ from: r.from, to: r.to })} />
        <FilterToggle label="Overdue" hint="Scheduled start has passed and the visit is still open" checked={state.overdue === 'true'} onChange={(v) => set({ overdue: v ? 'true' : undefined })} />
        <FilterToggle label="Awaiting acknowledgement" hint="Completed, not yet signed off by the customer" checked={state.unacknowledged === 'true'} onChange={(v) => set({ unacknowledged: v ? 'true' : undefined })} />
      </FilterGroup>
    </>
  );

  if (toCalendar) return null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Visits"
        subtitle={summary.data ? <span>{summary.data.byStatus.scheduled ?? 0} scheduled · {summary.data.byStatus.in_progress ?? 0} on site · {summary.data.entitlements.used}/{summary.data.entitlements.entitled} entitled visits used</span> : 'Engineer visits to customer sites'}
        actions={can('field:manage') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New visit</Button> : undefined}
      />

      <ListShell
        id="field-visits"
        modules={FIELD_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search number or title…' }}
        filters={filters}
        activeCount={activeFilterCount}
        onClear={clearFilters}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} ${list.data.total === 1 ? 'visit' : 'visits'}` : undefined}
        quick={
          <>
            {VISIT_STATUSES.map((st: VisitStatus) => (
              <FilterChip key={st} active={statuses.includes(st)} onClick={() => toggleStatus(st)} dot={dotClass(VISIT_STATUS_COLORS[st])} count={summary.data?.byStatus?.[st] ?? 0}>
                {STATUS_LABELS[st]}
              </FilterChip>
            ))}
          </>
        }
        toolbar={<Segmented size="sm" options={[{ value: 'list', label: <span className="inline-flex items-center gap-1.5"><ListIcon className="h-3.5 w-3.5" />List</span> }, { value: 'calendar', label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Calendar</span> }]} value="list" onChange={(v) => v === 'calendar' && navigate('/field/calendar')} />}
        insights={
          <InsightBand
            id="field"
            loading={summary.isLoading}
            summary={summary.data ? `${fmtNumber(summary.data.total)} visits in the last 90 days${state.customerId ? ' for this customer' : ''}` : undefined}
            kpis={
              tiles
                ? [
                    { label: 'Scheduled this week', value: fmtNumber(tiles.scheduledThisWeek), icon: <CalendarDays className="h-4 w-4" />, hint: `${fmtNumber(tiles.requested)} requested, not yet scheduled`, onClick: () => navigate('/field/calendar') },
                    { label: 'On site now', value: fmtNumber(tiles.inProgress), tone: tiles.inProgress ? 'warn' : 'default', icon: <Wrench className="h-4 w-4" />, hint: tiles.overdue ? `${fmtNumber(tiles.overdue)} overdue` : 'nothing overdue', onClick: () => set({ status: 'in_progress', overdue: undefined }) },
                    { label: 'Completed this month', value: fmtNumber(tiles.completedThisMonth), tone: 'good', icon: <BadgeCheck className="h-4 w-4" />, hint: summary.data?.avgWorkMinutes ? `avg ${fmtDuration(summary.data.avgWorkMinutes)} on site` : undefined, onClick: () => set({ status: 'completed', from: ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: undefined }) },
                    { label: 'Pending acknowledgement', value: fmtNumber(tiles.pendingAcknowledgement), tone: tiles.pendingAcknowledgement ? 'warn' : 'good', icon: <Clock className="h-4 w-4" />, hint: 'completed, awaiting customer sign-off', onClick: () => set({ status: 'completed', unacknowledged: 'true' }) },
                  ]
                : []
            }
            panels={
              summary.data && (
                <>
                  <Panel title="Visits by status" subtitle="Last 90 days · click to filter">
                    <BreakdownBar dense items={VISIT_STATUSES.map((st) => ({ label: STATUS_LABELS[st], value: summary.data?.byStatus?.[st] ?? 0, color: VISIT_STATUS_COLORS[st], active: statuses.length === 1 && statuses[0] === st })).filter((i) => i.value > 0)} onSelect={(i) => { const st = VISIT_STATUSES.find((x) => STATUS_LABELS[x] === i.label); if (st) set({ status: st }); }} />
                  </Panel>
                  <Panel title="Top engineers" subtitle="Completed visits and time on site">
                    <RowList dense empty="No completed visits yet" items={summary.data.topEngineers.slice(0, 6).map((e) => ({ key: e.engineerId ?? e.engineerName ?? 'none', leading: <Avatar name={e.engineerName} size="xs" />, primary: e.engineerName ?? 'Unassigned', secondary: `${fmtDuration(e.workMinutes)} on site`, right: `${fmtNumber(e.count)} visits` }))} />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable
            columns={columns}
            rows={list.data?.items ?? []}
            loading={list.isLoading}
            dense
            rowClassName={(r) => (r.status === 'completed' && !r.customerAckAt ? 'row-rail-warn' : r.scheduledStart && ['requested', 'scheduled'].includes(r.status) && new Date(r.scheduledStart).getTime() < Date.now() ? 'row-rail-bad' : undefined)}
            onRowClick={(r) => navigate(`/field/${r.id}`)}
            sort={{ key: state.sort ?? 'scheduledStart', order: (state.order as 'asc' | 'desc') ?? 'asc' }}
            onSort={(key) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false)}
            empty={
              <div className="py-10 text-center">
                <div className="font-medium">No visits match these filters</div>
                <div className="text-[13px] text-muted mt-1">Adjust the filters or <button className="text-brand-600 hover:underline" onClick={clearFilters}>clear them</button>.</div>
              </div>
            }
          />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
          {list.isError && <div className="px-3 py-2 text-[12.5px] text-red-600">{(list.error as Error).message}</div>}
        </div>
      </ListShell>

      <VisitForm
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultCustomerId={state.customerId}
        onSaved={(v) => {
          setCreateOpen(false);
          qc.invalidateQueries({ queryKey: fieldKeys.all });
          navigate(`/field/${v.id}`);
        }}
      />
    </div>
  );
}
