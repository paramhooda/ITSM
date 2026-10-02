import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, CalendarDays, List as ListIcon, Clock, Wrench, BadgeCheck, Hourglass } from 'lucide-react';
import { PageHeader, Button, Select, SearchInput, DataTable, Pagination, Input, Checkbox, Avatar, FilterBar, FilterChip, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList, Segmented } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, fmtDate, fmtNumber, fmtDuration } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { VISIT_STATUS_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { fieldApi, fieldKeys } from '@/components/field/api';
import { VisitStatusBadge } from '@/components/field/VisitStatusBadge';
import { VisitForm } from '@/components/field/VisitForm';
import { VisitCalendar, startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';
import { STATUS_LABELS, VISIT_STATUSES, type VisitListRow, type VisitStatus } from '@/components/field/types';

const FILTER_KEYS = ['q', 'customerId', 'status', 'engineerId', 'teamId', 'typeId', 'from', 'to', 'mine', 'unacknowledged'];
const DEFAULTS = { status: 'requested,scheduled,in_progress', sort: 'scheduledStart', order: 'asc', view: 'list' };

export default function FieldVisitListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const me = useAuthStore((s) => s.user);
  const [createOpen, setCreateOpen] = useState(false);
  const view = state.view === 'calendar' ? 'calendar' : 'list';

  const params = useMemo(() => {
    const p: Record<string, unknown> = { page, pageSize, sort: state.sort, order: state.order };
    for (const k of ['q', 'customerId', 'status', 'engineerId', 'teamId', 'typeId', 'from', 'to'] as const) if (state[k]) p[k] = state[k];
    if (state.mine === 'true') p.mine = 'true';
    if (state.unacknowledged === 'true') p.unacknowledged = 'true';
    return p;
  }, [state, page, pageSize]);
  const list = useQuery({ queryKey: fieldKeys.list(params), queryFn: () => fieldApi.list(params), placeholderData: (prev) => prev, enabled: view === 'list' });
  const summaryParams = useMemo(() => (state.customerId ? { customerId: state.customerId } : {}), [state.customerId]);
  const summary = useQuery({ queryKey: fieldKeys.summary(summaryParams), queryFn: () => fieldApi.summary(summaryParams), refetchInterval: 60_000 });

  const weekStart = useMemo(() => (state.week ? startOfWeek(new Date(state.week + 'T00:00:00')) : startOfWeek(new Date())), [state.week]);
  const calParams = useMemo(() => ({ from: ymd(weekStart), to: ymd(addDays(weekStart, 7)), engineerId: state.mine === 'true' ? undefined : state.engineerId || undefined, teamId: state.teamId || undefined, customerId: state.customerId || undefined }), [weekStart, state.engineerId, state.teamId, state.customerId, state.mine]);
  const calendar = useQuery({ queryKey: fieldKeys.calendar(calParams), queryFn: () => fieldApi.calendar(calParams), enabled: view === 'calendar', placeholderData: (prev) => prev });

  const statuses = (state.status ?? '').split(',').filter(Boolean);
  const toggleStatus = (key: string) => set({ status: (statuses.includes(key) ? statuses.filter((s) => s !== key) : [...statuses, key]).join(',') });
  const activeFilterCount = ['q', 'customerId', 'engineerId', 'teamId', 'typeId', 'from', 'to', 'mine', 'unacknowledged'].filter((k) => state[k]).length + (state.status !== DEFAULTS.status ? 1 : 0);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

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
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const teams = lookups?.teams ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Field service"
        subtitle={summary.data ? <span>{summary.data.byStatus.scheduled ?? 0} scheduled · {summary.data.byStatus.in_progress ?? 0} on site · {summary.data.entitlements.used}/{summary.data.entitlements.entitled} entitled visits used</span> : undefined}
        actions={can('field:manage') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New visit</Button> : undefined}
      />

      <FilterBar
        activeCount={activeFilterCount}
        onClear={clearFilters}
        trailing={<Segmented size="sm" options={[{ value: 'list', label: <span className="inline-flex items-center gap-1.5"><ListIcon className="h-3.5 w-3.5" />List</span> }, { value: 'calendar', label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Calendar</span> }]} value={view} onChange={(v) => set({ view: v }, false)} />}
        chips={
          view === 'list' ? (
            <>
              {VISIT_STATUSES.map((st: VisitStatus) => (
                <FilterChip key={st} active={statuses.includes(st)} onClick={() => toggleStatus(st)} dot={dotClass(VISIT_STATUS_COLORS[st])} count={summary.data?.byStatus?.[st] ?? 0}>
                  {STATUS_LABELS[st]}
                </FilterChip>
              ))}
              {state.unacknowledged === 'true' && (
                <FilterChip active onClick={() => set({ unacknowledged: undefined })} dot={dotClass('amber')}>
                  Pending acknowledgement ×
                </FilterChip>
              )}
            </>
          ) : undefined
        }
      >
        {view === 'list' && <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search number or title…" className="w-56" />}
        <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" className="w-48 h-8 py-0 text-[13px]" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
        <Select value={state.engineerId ?? ''} onChange={(e) => set({ engineerId: e.target.value, mine: undefined })} placeholder="Engineer" className="w-44 h-8 py-0 text-[13px]" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        <Select value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Team" className="w-40 h-8 py-0 text-[13px]" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
        {view === 'list' && (
          <>
            <Select value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="Type" className="w-44 h-8 py-0 text-[13px]" options={options('field_visit_type').map((o) => ({ value: o.id, label: o.label }))} />
            <Input type="date" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Scheduled from" aria-label="Scheduled from" />
            <Input type="date" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Scheduled to" aria-label="Scheduled to" />
          </>
        )}
        <Checkbox checked={state.mine === 'true'} onChange={(e) => set({ mine: e.target.checked ? 'true' : undefined, engineerId: undefined })} label="Mine" />
      </FilterBar>

      <InsightBand
        id="field"
        loading={summary.isLoading}
        summary={summary.data ? `${fmtNumber(summary.data.total)} visits in the last 90 days${state.customerId ? ' for this customer' : ''}` : undefined}
        kpis={
          tiles
            ? [
                { label: 'Scheduled this week', value: fmtNumber(tiles.scheduledThisWeek), icon: <CalendarDays className="h-4 w-4" />, hint: `${fmtNumber(tiles.requested)} requested, not yet scheduled`, onClick: () => set({ view: 'calendar', week: undefined }, false) },
                { label: 'On site now', value: fmtNumber(tiles.inProgress), tone: tiles.inProgress ? 'warn' : 'default', icon: <Wrench className="h-4 w-4" />, hint: tiles.overdue ? `${fmtNumber(tiles.overdue)} overdue` : 'nothing overdue', onClick: () => set({ view: 'list', status: 'in_progress' }) },
                { label: 'Completed this month', value: fmtNumber(tiles.completedThisMonth), tone: 'good', icon: <BadgeCheck className="h-4 w-4" />, hint: summary.data?.avgWorkMinutes ? `avg ${fmtDuration(summary.data.avgWorkMinutes)} on site` : undefined, onClick: () => set({ view: 'list', status: 'completed', from: ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: undefined }) },
                { label: 'Pending acknowledgement', value: fmtNumber(tiles.pendingAcknowledgement), tone: tiles.pendingAcknowledgement ? 'warn' : 'good', icon: <Clock className="h-4 w-4" />, hint: 'completed, awaiting customer sign-off', onClick: () => set({ view: 'list', status: 'completed', unacknowledged: 'true' }) },
              ]
            : []
        }
        panels={
          summary.data && (
            <>
              <Panel title="Visits by status" subtitle="Last 90 days · click to filter">
                <BreakdownBar dense items={VISIT_STATUSES.map((st) => ({ label: STATUS_LABELS[st], value: summary.data?.byStatus?.[st] ?? 0, color: VISIT_STATUS_COLORS[st], active: statuses.length === 1 && statuses[0] === st })).filter((i) => i.value > 0)} onSelect={(i) => { const st = VISIT_STATUSES.find((x) => STATUS_LABELS[x] === i.label); if (st) set({ view: 'list', status: st }); }} />
              </Panel>
              <Panel title="Top engineers" subtitle="Completed visits and time on site">
                <RowList dense empty="No completed visits yet" items={summary.data.topEngineers.slice(0, 6).map((e) => ({ key: e.engineerId ?? e.engineerName ?? 'none', leading: <Avatar name={e.engineerName} size="xs" />, primary: e.engineerName ?? 'Unassigned', secondary: `${fmtDuration(e.workMinutes)} on site`, right: `${fmtNumber(e.count)} visits` }))} />
              </Panel>
            </>
          )
        }
      />

      {view === 'list' ? (
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
      ) : (
        <VisitCalendar weekStart={weekStart} items={(calendar.data?.items ?? []).filter((v) => state.mine !== 'true' || v.engineerId === me?.id || v.additionalEngineerIds.includes(me?.id ?? ''))} loading={calendar.isFetching} onWeekChange={(d) => set({ week: ymd(d) }, false)} onSelect={(id) => navigate(`/field/${id}`)} />
      )}

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
