import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, X, Filter, CalendarDays, List as ListIcon, MoreHorizontal, CalendarPlus, CheckCircle2, RefreshCw, Ban, Ticket, ExternalLink, AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck } from 'lucide-react';
import { PageHeader, Button, Select, SearchInput, DataTable, Pagination, Input, Checkbox, StatTile, Tabs, Badge, Card, EmptyState, type Column } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate, fmtPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { itemsOf } from '@/components/tickets/api';
import { pmApi, pmKeys } from '@/components/pm/api';
import { OccurrenceStatusBadge, FrequencyBadge, DueIn } from '@/components/pm/OccurrenceStatusBadge';
import { ScheduleOccurrenceDialog } from '@/components/pm/ScheduleOccurrenceDialog';
import { CompleteOccurrenceDialog, RescheduleOccurrenceDialog, CancelOccurrenceDialog } from '@/components/pm/OccurrenceActions';
import { ProgramForm } from '@/components/pm/ProgramForm';
import { ProgramDrawer } from '@/components/pm/ProgramDrawer';
import { PM_STATUSES, PM_STATUS_LABELS, PM_STATUS_COLORS, FREQUENCY_LABELS, type OccurrenceRow, type ProgramRow, type PmStatus, type PmFrequency } from '@/components/pm/types';

type Tab = 'schedule' | 'programs' | 'performance';
const TABS: { key: Tab; label: string }[] = [
  { key: 'schedule', label: 'Schedule' },
  { key: 'programs', label: 'Programs' },
  { key: 'performance', label: 'Performance' },
];
const DEFAULTS = { tab: 'schedule', status: 'planned,scheduled,rescheduled,missed', sort: 'plannedDate', order: 'asc' };
const FILTER_KEYS = ['q', 'customerId', 'status', 'from', 'to', 'engineerId', 'teamId', 'overdue', 'mine', 'frequency', 'isActive', 'siteId'];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function MaintenancePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const tab = (state.tab as Tab) ?? 'schedule';
  const [dialog, setDialog] = useState<{ kind: 'schedule' | 'complete' | 'reschedule' | 'cancel'; occ: OccurrenceRow } | null>(null);
  const [newProgram, setNewProgram] = useState(false);
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: pmKeys.all });
    qc.invalidateQueries({ queryKey: ['field'] });
  };
  const closeDialog = () => {
    setDialog(null);
    invalidate();
  };
  const createTicket = useMutation({ mutationFn: (id: string) => pmApi.createTicket(id), onSuccess: (r) => { toast.success(`Ticket ${r.ticket.number} created`); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });

  // ------------------------------------------------------------ schedule tab
  const occParams = useMemo(() => {
    const p: Record<string, unknown> = { page, pageSize, sort: state.sort, order: state.order };
    for (const k of ['q', 'customerId', 'status', 'from', 'to', 'engineerId', 'teamId', 'siteId'] as const) if (state[k]) p[k] = state[k];
    if (state.overdue === 'true') p.overdue = 'true';
    if (state.mine === 'true') p.mine = 'true';
    return p;
  }, [state, page, pageSize]);
  const occurrences = useQuery({ queryKey: pmKeys.occurrences(occParams), queryFn: () => pmApi.occurrences(occParams), enabled: tab === 'schedule' && state.view !== 'calendar', placeholderData: (prev) => prev });
  const summaryParams = useMemo(() => (state.customerId ? { customerId: state.customerId } : {}), [state.customerId]);
  const summary = useQuery({ queryKey: pmKeys.summary(summaryParams), queryFn: () => pmApi.summary(summaryParams), refetchInterval: 60_000 });
  const month = useMemo(() => (state.month ? new Date(state.month + '-01T00:00:00') : new Date(new Date().getFullYear(), new Date().getMonth(), 1)), [state.month]);
  const calParams = useMemo(() => ({ from: ymd(new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))), to: ymd(new Date(month.getFullYear(), month.getMonth() + 1, 7)), customerId: state.customerId || undefined, engineerId: state.engineerId || undefined, teamId: state.teamId || undefined }), [month, state.customerId, state.engineerId, state.teamId]);
  const calendar = useQuery({ queryKey: pmKeys.calendar(calParams), queryFn: () => pmApi.calendar(calParams), enabled: tab === 'schedule' && state.view === 'calendar', placeholderData: (prev) => prev });

  const statuses = (state.status ?? '').split(',').filter(Boolean);
  const toggleStatus = (key: string) => set({ status: (statuses.includes(key) ? statuses.filter((s) => s !== key) : [...statuses, key]).join(',') });
  const activeFilterCount = ['q', 'customerId', 'from', 'to', 'engineerId', 'teamId', 'overdue', 'mine', 'frequency', 'isActive', 'siteId'].filter((k) => state[k]).length + (state.status !== DEFAULTS.status ? 1 : 0);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const canManage = can('pm:manage');

  const rowActions = (o: OccurrenceRow) => {
    const open = ['planned', 'scheduled', 'rescheduled', 'missed'].includes(o.status);
    const items = [] as { label: string; icon: JSX.Element; onClick: () => void; danger?: boolean }[];
    if (canManage && open) items.push({ label: o.status === 'planned' || o.status === 'missed' ? 'Schedule' : 'Move / re-assign', icon: <CalendarPlus className="h-3.5 w-3.5" />, onClick: () => setDialog({ kind: 'schedule', occ: o }) });
    if ((canManage || can('field:execute')) && open) items.push({ label: 'Mark completed', icon: <CheckCircle2 className="h-3.5 w-3.5" />, onClick: () => setDialog({ kind: 'complete', occ: o }) });
    if (canManage && open) items.push({ label: 'Reschedule', icon: <RefreshCw className="h-3.5 w-3.5" />, onClick: () => setDialog({ kind: 'reschedule', occ: o }) });
    if (canManage && !o.ticketId && o.status !== 'cancelled') items.push({ label: 'Create ticket', icon: <Ticket className="h-3.5 w-3.5" />, onClick: () => createTicket.mutate(o.id) });
    if (o.fieldVisitId) items.push({ label: `Open visit ${o.fieldVisitNumber}`, icon: <ExternalLink className="h-3.5 w-3.5" />, onClick: () => navigate(`/field/${o.fieldVisitId}`) });
    if (canManage && open) items.push({ label: 'Cancel', icon: <Ban className="h-3.5 w-3.5" />, onClick: () => setDialog({ kind: 'cancel', occ: o }), danger: true });
    items.push({ label: 'Open program', icon: <ClipboardCheck className="h-3.5 w-3.5" />, onClick: () => set({ tab: 'programs', program: o.programId }, false) });
    return items;
  };

  const occColumns: Column<OccurrenceRow>[] = [
    { key: 'plannedDate', header: 'Planned', sortable: true, width: '150px', render: (o) => <div className="whitespace-nowrap"><div className="text-[13px]">{fmtDate(o.plannedDate)}</div><DueIn days={o.daysUntil} status={o.status} /></div> },
    { key: 'program', header: 'Program', sortable: true, render: (o) => <div className="min-w-[200px] max-w-[420px]"><button className="font-medium text-[13.5px] hover:underline text-left truncate block max-w-full" onClick={(e) => { e.stopPropagation(); set({ tab: 'programs', program: o.programId }, false); }}>{o.programName}</button><div className="text-[11.5px] text-muted truncate">{o.customerName}{o.siteName ? ` · ${o.siteName}` : ''} · {FREQUENCY_LABELS[o.frequency as PmFrequency] ?? o.frequency}</div></div> },
    { key: 'scheduledDate', header: 'Scheduled', width: '120px', render: (o) => (o.scheduledDate ? fmtDate(o.scheduledDate) : <span className="text-subtle">—</span>) },
    { key: 'status', header: 'Status', sortable: true, width: '170px', render: (o) => <OccurrenceStatusBadge status={o.status} overdue={o.overdue} /> },
    { key: 'engineer', header: 'Engineer', width: '150px', render: (o) => <span className="text-[13px]">{o.engineerName ?? <span className="text-subtle">{o.teamName ?? 'Unassigned'}</span>}</span> },
    { key: 'visit', header: 'Visit / ticket', width: '150px', render: (o) => <div className="flex flex-col text-[12px] font-mono">{o.fieldVisitId && <Link to={`/field/${o.fieldVisitId}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 dark:text-brand-300 hover:underline">{o.fieldVisitNumber}</Link>}{o.ticketId && <Link to={`/tickets/${o.ticketId}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 dark:text-brand-300 hover:underline">{o.ticketNumber}</Link>}{!o.fieldVisitId && !o.ticketId && <span className="text-subtle">—</span>}</div> },
    { key: 'actions', header: '', width: '48px', render: (o) => <div onClick={(e) => e.stopPropagation()}><Menu trigger={<Button variant="ghost" size="icon" aria-label="Actions"><MoreHorizontal className="h-4 w-4" /></Button>} items={rowActions(o)} /></div> },
  ];

  // ------------------------------------------------------------ programs tab
  const progParams = useMemo(() => {
    const p: Record<string, unknown> = { page, pageSize, sort: state.sort === 'plannedDate' ? 'name' : state.sort, order: state.sort === 'plannedDate' ? 'asc' : state.order };
    for (const k of ['q', 'customerId', 'frequency', 'siteId'] as const) if (state[k]) p[k] = state[k];
    if (state.teamId) p.assignedTeamId = state.teamId;
    if (state.engineerId) p.assignedEngineerId = state.engineerId;
    if (state.isActive) p.isActive = state.isActive;
    return p;
  }, [state, page, pageSize]);
  const programs = useQuery({ queryKey: pmKeys.programs(progParams), queryFn: () => pmApi.programs(progParams), enabled: tab === 'programs', placeholderData: (prev) => prev });
  const progColumns: Column<ProgramRow>[] = [
    { key: 'name', header: 'Program', sortable: true, render: (p) => <div className="min-w-[200px]"><div className="font-medium text-[13.5px] truncate">{p.name}</div><div className="text-[11.5px] text-muted truncate">{p.customerName}{p.siteName ? ` · ${p.siteName}` : ''}{p.serviceName ? ` · ${p.serviceName}` : ''}</div></div> },
    { key: 'frequency', header: 'Frequency', sortable: true, width: '130px', render: (p) => <FrequencyBadge frequency={p.frequency} intervalDays={p.intervalDays} /> },
    { key: 'nextDue', header: 'Next due', width: '120px', render: (p) => (p.nextDue ? <span className={cn(p.overdue > 0 && 'text-red-600 dark:text-red-400 font-medium')}>{fmtDate(p.nextDue)}</span> : <span className="text-subtle">—</span>) },
    { key: 'open', header: 'Open', width: '90px', render: (p) => <span>{p.open}{p.overdue > 0 && <span className="text-red-600 dark:text-red-400 text-[11.5px]"> · {p.overdue} late</span>}</span> },
    { key: 'last12', header: 'Last 12 months', width: '140px', render: (p) => <span className="text-[12.5px]"><span className="text-emerald-600">{p.completed12m} done</span> · <span className={p.missed12m ? 'text-red-600' : 'text-muted'}>{p.missed12m} missed</span></span> },
    { key: 'owner', header: 'Owner', width: '160px', render: (p) => <span className="text-[13px]">{p.engineerName ?? p.teamName ?? <span className="text-subtle">—</span>}</span> },
    { key: 'entitlement', header: 'Entitlement', width: '150px', render: (p) => <span className="text-[12.5px]">{p.entitlementName ?? <span className="text-subtle">not metered</span>}</span> },
    { key: 'active', header: 'Active', width: '80px', render: (p) => <Badge color={p.isActive ? 'green' : 'gray'} dot>{p.isActive ? 'Yes' : 'No'}</Badge> },
  ];

  // ------------------------------------------------------------ render
  const s = summary.data;
  const teams = lookups?.teams ?? [];
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Preventive maintenance"
        subtitle={s ? <span>{s.counts.planned + s.counts.scheduled + s.counts.rescheduled} open · {s.overdue.length} overdue · {s.counts.completed} completed · on-time {fmtPct(s.onTimePct, 0)}</span> : undefined}
        actions={canManage ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setNewProgram(true)}>New program</Button> : undefined}
      />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile label="Overdue" value={s?.overdue.length ?? '—'} tone={s?.overdue.length ? 'bad' : 'default'} icon={<AlertTriangle className="h-4 w-4" />} onClick={() => set({ tab: 'schedule', view: undefined, overdue: 'true', status: 'planned,scheduled,rescheduled' })} />
        <StatTile label="Due in 30 days" value={s?.upcoming.length ?? '—'} icon={<CalendarDays className="h-4 w-4" />} onClick={() => set({ tab: 'schedule', view: undefined, overdue: undefined, status: 'planned,scheduled,rescheduled', from: ymd(new Date()), to: ymd(new Date(Date.now() + 30 * 86_400_000)) })} />
        <StatTile label="Missed (12 mo)" value={s?.counts.missed ?? '—'} tone={s?.counts.missed ? 'bad' : 'default'} onClick={() => set({ tab: 'schedule', view: undefined, status: 'missed', from: undefined, to: undefined, overdue: undefined })} />
        <StatTile label="Completed (12 mo)" value={s?.counts.completed ?? '—'} tone="good" onClick={() => set({ tab: 'schedule', view: undefined, status: 'completed', from: undefined, to: undefined, overdue: undefined })} />
        <StatTile label="On time" value={s ? fmtPct(s.onTimePct, 0) : '—'} hint={s ? `completion ${fmtPct(s.completionPct, 0)}` : undefined} tone={s?.onTimePct !== null && s?.onTimePct !== undefined && s.onTimePct < 80 ? 'warn' : 'default'} onClick={() => set({ tab: 'performance' }, false)} />
      </div>

      <Tabs tabs={TABS} value={tab} onChange={(t) => set({ tab: t, page: undefined }, false)} />

      {tab !== 'performance' && (
        <div className="card p-2.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {tab === 'schedule' && (
              <div className="inline-flex rounded-lg border border-default overflow-hidden">
                <button className={cn('px-2.5 py-1 text-[12.5px] inline-flex items-center gap-1', state.view !== 'calendar' ? 'bg-surface-2 font-medium' : 'text-muted')} onClick={() => set({ view: undefined }, false)}><ListIcon className="h-3.5 w-3.5" />List</button>
                <button className={cn('px-2.5 py-1 text-[12.5px] inline-flex items-center gap-1 border-l border-default', state.view === 'calendar' ? 'bg-surface-2 font-medium' : 'text-muted')} onClick={() => set({ view: 'calendar' }, false)}><CalendarDays className="h-3.5 w-3.5" />Calendar</button>
              </div>
            )}
            <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search program…" className="w-52" />
            <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" className="w-48 h-8 py-0 text-[13px]" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            <Select value={state.engineerId ?? ''} onChange={(e) => set({ engineerId: e.target.value, mine: undefined })} placeholder="Engineer" className="w-44 h-8 py-0 text-[13px]" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
            <Select value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Team" className="w-40 h-8 py-0 text-[13px]" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
            {tab === 'schedule' && state.view !== 'calendar' && (
              <>
                <Input type="date" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Planned from" />
                <Input type="date" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Planned to" />
                <Checkbox checked={state.overdue === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : undefined })} label="Overdue" />
                <Checkbox checked={state.mine === 'true'} onChange={(e) => set({ mine: e.target.checked ? 'true' : undefined, engineerId: undefined })} label="Mine" />
              </>
            )}
            {tab === 'programs' && (
              <>
                <Select value={state.frequency ?? ''} onChange={(e) => set({ frequency: e.target.value })} placeholder="Frequency" className="w-40 h-8 py-0 text-[13px]" options={(Object.keys(FREQUENCY_LABELS) as PmFrequency[]).map((k) => ({ value: k, label: FREQUENCY_LABELS[k] }))} />
                <Select value={state.isActive ?? ''} onChange={(e) => set({ isActive: e.target.value })} placeholder="Active + inactive" className="w-40 h-8 py-0 text-[13px]" options={[{ value: 'true', label: 'Active only' }, { value: 'false', label: 'Inactive only' }]} />
              </>
            )}
            {activeFilterCount > 0 && <Button variant="ghost" size="sm" onClick={clearFilters} icon={<X className="h-3.5 w-3.5" />}>Clear</Button>}
          </div>
          {tab === 'schedule' && state.view !== 'calendar' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-subtle mr-0.5" />
              {PM_STATUSES.map((st: PmStatus) => {
                const on = statuses.includes(st);
                return (
                  <button key={st} onClick={() => toggleStatus(st)} className={cn('rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors', on ? 'border-brand-500 bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'border-default text-muted hover:text-default')}>
                    {PM_STATUS_LABELS[st]} <span className="opacity-60">{s?.counts[st] ?? 0}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'schedule' && state.view !== 'calendar' && (
        <div className="card overflow-hidden">
          <DataTable columns={occColumns} rows={occurrences.data?.items ?? []} loading={occurrences.isLoading} dense sort={{ key: state.sort ?? 'plannedDate', order: (state.order as 'asc' | 'desc') ?? 'asc' }} onSort={(key) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false)} empty={<div className="py-10 text-center"><div className="font-medium">No occurrences match these filters</div><div className="text-[13px] text-muted mt-1">Adjust the filters or <button className="text-brand-600 hover:underline" onClick={clearFilters}>clear them</button>.</div></div>} />
          <Pagination page={page} pageSize={pageSize} total={occurrences.data?.total ?? 0} onPage={setPage} />
          {occurrences.isError && <div className="px-3 py-2 text-[12.5px] text-red-600">{(occurrences.error as Error).message}</div>}
        </div>
      )}
      {tab === 'schedule' && state.view === 'calendar' && (
        <MonthCalendar month={month} items={calendar.data?.items ?? []} loading={calendar.isFetching} onMonthChange={(d) => set({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }, false)} onSelect={(o) => (canManage && ['planned', 'scheduled', 'rescheduled', 'missed'].includes(o.status) ? setDialog({ kind: 'schedule', occ: o }) : o.fieldVisitId ? navigate(`/field/${o.fieldVisitId}`) : set({ tab: 'programs', program: o.programId }, false))} />
      )}

      {tab === 'programs' && (
        <div className="card overflow-hidden">
          <DataTable columns={progColumns} rows={programs.data?.items ?? []} loading={programs.isLoading} dense onRowClick={(p) => set({ program: p.id }, false)} sort={{ key: progParams.sort as string, order: progParams.order as 'asc' | 'desc' }} onSort={(key) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false)} empty={<EmptyState title="No programs" description="Create a program to generate the maintenance schedule." action={canManage ? <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setNewProgram(true)}>New program</Button> : undefined} />} />
          <Pagination page={page} pageSize={pageSize} total={programs.data?.total ?? 0} onPage={setPage} />
        </div>
      )}

      {tab === 'performance' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <Card title={`By customer (${s ? `${fmtDate(s.range.from)} – ${fmtDate(s.range.to)}` : ''})`} padded={false}>
            {!s || s.perCustomer.length === 0 ? (
              <EmptyState title="No maintenance data" />
            ) : (
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Customer</th><th className="text-right">Programs</th><th className="text-right">Open</th><th className="text-right">Completed</th><th className="text-right">Missed</th><th className="text-right">On time</th></tr></thead>
                <tbody>
                  {s.perCustomer.map((c) => (
                    <tr key={c.customerId} className="clickable" onClick={() => set({ tab: 'schedule', customerId: c.customerId }, false)}>
                      <td className="font-medium">{c.customerName ?? '—'}</td>
                      <td className="text-right tabular-nums">{c.programs}</td>
                      <td className="text-right tabular-nums">{c.planned}</td>
                      <td className="text-right tabular-nums text-emerald-600">{c.completed}</td>
                      <td className={cn('text-right tabular-nums', c.missed && 'text-red-600 font-medium')}>{c.missed}</td>
                      <td className="text-right tabular-nums">{fmtPct(c.onTimePct, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <div className="flex flex-col gap-3">
            <OccurrenceList title="Overdue" tone="bad" items={s?.overdue ?? []} empty="Nothing overdue." onSchedule={canManage ? (o) => setDialog({ kind: 'schedule', occ: o }) : undefined} />
            <OccurrenceList title="Upcoming 30 days" items={s?.upcoming ?? []} empty="Nothing due in the next 30 days." onSchedule={canManage ? (o) => setDialog({ kind: 'schedule', occ: o }) : undefined} />
          </div>
        </div>
      )}

      <ScheduleOccurrenceDialog open={dialog?.kind === 'schedule'} occurrence={dialog?.occ ?? null} onClose={() => setDialog(null)} onDone={closeDialog} />
      <CompleteOccurrenceDialog open={dialog?.kind === 'complete'} occurrence={dialog?.occ ?? null} onClose={() => setDialog(null)} onDone={closeDialog} />
      <RescheduleOccurrenceDialog open={dialog?.kind === 'reschedule'} occurrence={dialog?.occ ?? null} onClose={() => setDialog(null)} onDone={closeDialog} />
      <CancelOccurrenceDialog open={dialog?.kind === 'cancel'} occurrence={dialog?.occ ?? null} onClose={() => setDialog(null)} onDone={closeDialog} />
      <ProgramForm open={newProgram} defaultCustomerId={state.customerId} onClose={() => setNewProgram(false)} onSaved={(p) => { setNewProgram(false); invalidate(); set({ tab: 'programs', program: p.id }, false); }} />
      <ProgramDrawer programId={state.program ?? null} onClose={() => set({ program: undefined }, false)} onSchedule={async (occId) => { const occ = await pmApi.occurrence(occId); setDialog({ kind: 'schedule', occ }); }} />
    </div>
  );
}

function OccurrenceList({ title, tone, items, empty, onSchedule }: { title: string; tone?: 'bad'; items: OccurrenceRow[]; empty: string; onSchedule?: (o: OccurrenceRow) => void }) {
  return (
    <Card title={`${title} (${items.length})`} padded={false}>
      {items.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-subtle">{empty}</div>
      ) : (
        <ul className="divide-y divide-[var(--border)] max-h-[360px] overflow-auto">
          {items.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
              <span className={cn('w-24 shrink-0 tabular-nums', tone === 'bad' && 'text-red-600 dark:text-red-400 font-medium')}>{fmtDate(o.effectiveDate)}</span>
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{o.programName}</div><div className="text-[11.5px] text-muted truncate">{o.customerName}{o.siteName ? ` · ${o.siteName}` : ''}{o.engineerName ? ` · ${o.engineerName}` : ''}</div></div>
              <OccurrenceStatusBadge status={o.status} />
              {onSchedule && <Button size="sm" variant="ghost" icon={<CalendarPlus className="h-3.5 w-3.5" />} onClick={() => onSchedule(o)}>{o.status === 'planned' || o.status === 'missed' ? 'Schedule' : 'Move'}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Month grid of occurrences by effective date (scheduled date when set, else planned). */
function MonthCalendar({ month, items, loading, onMonthChange, onSelect }: { month: Date; items: OccurrenceRow[]; loading?: boolean; onMonthChange: (d: Date) => void; onSelect: (o: OccurrenceRow) => void }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const byDay = new Map<string, OccurrenceRow[]>();
  for (const o of items) (byDay.get(o.effectiveDate) ?? byDay.set(o.effectiveDate, []).get(o.effectiveDate)!).push(o);
  const today = ymd(new Date());
  const chip: Record<string, string> = { planned: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200', scheduled: 'bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200', rescheduled: 'bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200', completed: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200', missed: 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-200', cancelled: 'bg-gray-50 text-gray-500 line-through dark:bg-gray-500/10' };
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-default">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => onMonthChange(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>This month</Button>
          <Button variant="ghost" size="icon" onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-2 text-[13px] font-medium">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-muted">{(['planned', 'scheduled', 'completed', 'missed'] as PmStatus[]).map((st) => <span key={st} className="inline-flex items-center gap-1"><span className={cn('h-2.5 w-2.5 rounded-sm', `bg-${PM_STATUS_COLORS[st]}-400`)} />{PM_STATUS_LABELS[st]}</span>)}{loading && <span>· loading…</span>}</div>
      </div>
      <div className="grid grid-cols-7 bg-surface-2 border-b border-default">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-2 py-1 text-[10.5px] uppercase tracking-wide text-subtle font-medium text-center">{d}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = ymd(d);
          const list = byDay.get(key) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div key={key} className={cn('min-h-[88px] border-b border-r border-default p-1 flex flex-col gap-1', !inMonth && 'bg-surface-2/40', key === today && 'bg-brand-50/40 dark:bg-brand-500/5')}>
              <div className={cn('text-[11px] text-right', inMonth ? 'text-muted' : 'text-subtle', key === today && 'font-semibold text-brand-700 dark:text-brand-300')}>{d.getDate()}</div>
              {list.slice(0, 4).map((o) => (
                <button key={o.id} onClick={() => onSelect(o)} className={cn('text-left rounded px-1.5 py-0.5 text-[11px] leading-tight truncate hover:brightness-95 dark:hover:brightness-125', chip[o.status] ?? chip.planned)} title={`${o.programName} · ${o.customerName ?? ''} · ${PM_STATUS_LABELS[o.status]}`}>
                  <span className="font-medium">{o.programName}</span> <span className="opacity-70">{o.customerName}</span>
                </button>
              ))}
              {list.length > 4 && <div className="text-[10.5px] text-subtle px-1">+{list.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
