import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, CalendarDays, List as ListIcon, MoreHorizontal, CalendarPlus, CheckCircle2, RefreshCw, Ban, Ticket, ExternalLink, AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, CalendarX2, BadgeCheck } from 'lucide-react';
import { PageHeader, Button, DataTable, Pagination, Badge, Card, EmptyState, FilterChip, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle, type Column, type AppliedFilter } from '@/components/ui';
import { FIELD_MODULES } from '@/layouts/modules';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { SlaGauge } from '@/components/dashboards/SlaGauge';
import { Menu } from '@/components/Menu';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useSites } from '@/components/cmdb/hooks';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate, fmtPct, fmtNumber } from '@/lib/format';
import { cn, dotClass } from '@/lib/utils';
import { PM_STATUS_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { pmApi, pmKeys } from '@/components/pm/api';
import { OccurrenceStatusBadge, FrequencyBadge, DueIn } from '@/components/pm/OccurrenceStatusBadge';
import { ScheduleOccurrenceDialog } from '@/components/pm/ScheduleOccurrenceDialog';
import { CompleteOccurrenceDialog, RescheduleOccurrenceDialog, CancelOccurrenceDialog } from '@/components/pm/OccurrenceActions';
import { ProgramForm } from '@/components/pm/ProgramForm';
import { ProgramDrawer } from '@/components/pm/ProgramDrawer';
import { PM_STATUSES, PM_STATUS_LABELS, FREQUENCY_LABELS, type OccurrenceRow, type ProgramRow, type PmStatus, type PmFrequency } from '@/components/pm/types';

type Tab = 'schedule' | 'programs' | 'performance';
const TABS: { value: Tab; label: string }[] = [
  { value: 'schedule', label: 'Schedule' },
  { value: 'programs', label: 'Programs' },
  { value: 'performance', label: 'Performance' },
];
const DEFAULTS = { tab: 'schedule', status: 'planned,scheduled,rescheduled,missed', sort: 'plannedDate', order: 'asc' };
const FILTER_KEYS = ['q', 'customerId', 'status', 'from', 'to', 'engineerId', 'teamId', 'overdue', 'mine', 'frequency', 'isActive', 'siteId', 'programId'];
const LEGEND: Record<string, string> = { planned: 'bg-slate-400', scheduled: 'bg-blue-400', rescheduled: 'bg-indigo-400', completed: 'bg-emerald-400', missed: 'bg-red-400', cancelled: 'bg-gray-300' };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Preventive maintenance module of Field Service: the schedule, the programs and how they perform. */
export default function MaintenancePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const sites = useSites(state.customerId);
  const can = useAuthStore((s) => s.can);
  const tab = (state.tab as Tab) ?? 'schedule';
  const calendarView = tab === 'schedule' && state.view === 'calendar';
  const listView = tab === 'schedule' && !calendarView;
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
    for (const k of ['q', 'customerId', 'status', 'from', 'to', 'engineerId', 'teamId', 'siteId', 'programId'] as const) if (state[k]) p[k] = state[k];
    if (state.overdue === 'true') p.overdue = 'true';
    if (state.mine === 'true') p.mine = 'true';
    return p;
  }, [state, page, pageSize]);
  const occurrences = useQuery({ queryKey: pmKeys.occurrences(occParams), queryFn: () => pmApi.occurrences(occParams), enabled: listView, placeholderData: (prev) => prev });
  const summaryParams = useMemo(() => (state.customerId ? { customerId: state.customerId } : {}), [state.customerId]);
  const summary = useQuery({ queryKey: pmKeys.summary(summaryParams), queryFn: () => pmApi.summary(summaryParams), refetchInterval: 60_000 });
  const month = useMemo(() => (state.month ? new Date(state.month + '-01T00:00:00') : new Date(new Date().getFullYear(), new Date().getMonth(), 1)), [state.month]);
  const calParams = useMemo(() => ({ from: ymd(new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))), to: ymd(new Date(month.getFullYear(), month.getMonth() + 1, 7)), customerId: state.customerId || undefined, engineerId: state.engineerId || undefined, teamId: state.teamId || undefined }), [month, state.customerId, state.engineerId, state.teamId]);
  const calendar = useQuery({ queryKey: pmKeys.calendar(calParams), queryFn: () => pmApi.calendar(calParams), enabled: calendarView, placeholderData: (prev) => prev });
  /** Programme picker for the schedule rail (scoped to the chosen customer). */
  const pickerParams = useMemo(() => ({ pageSize: 200, sort: 'name', order: 'asc', ...(state.customerId ? { customerId: state.customerId } : {}) }), [state.customerId]);
  const programPicker = useQuery({ queryKey: pmKeys.programs(pickerParams), queryFn: () => pmApi.programs(pickerParams), enabled: tab === 'schedule', staleTime: 60_000 });

  const statuses = (state.status ?? '').split(',').filter(Boolean);
  const toggleStatus = (key: string) => set({ status: (statuses.includes(key) ? statuses.filter((s) => s !== key) : [...statuses, key]).join(',') });
  const activeFilterCount = ['q', 'customerId', 'from', 'to', 'engineerId', 'teamId', 'overdue', 'mine', 'frequency', 'isActive', 'siteId', 'programId'].filter((k) => state[k]).length + (state.status !== DEFAULTS.status ? 1 : 0);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const canManage = can('pm:manage');
  const teams = lookups?.teams ?? [];
  const frequencies = Object.keys(FREQUENCY_LABELS) as PmFrequency[];

  const rowActions = (o: OccurrenceRow) => {
    const open = ['planned', 'scheduled', 'rescheduled', 'missed'].includes(o.status);
    const items = [] as { label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[];
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
    { key: 'visit', header: 'Visit / ticket', width: '150px', render: (o) => <div className="flex flex-col text-[12px] font-mono">{o.fieldVisitId && <Link to={`/field/${o.fieldVisitId}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline">{o.fieldVisitNumber}</Link>}{o.ticketId && <Link to={`/tickets/${o.ticketId}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline">{o.ticketNumber}</Link>}{!o.fieldVisitId && !o.ticketId && <span className="text-subtle">—</span>}</div> },
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
    { key: 'nextDue', header: 'Next due', width: '120px', render: (p) => (p.nextDue ? <span className={cn(p.overdue > 0 && 'text-red-600 font-medium')}>{fmtDate(p.nextDue)}</span> : <span className="text-subtle">—</span>) },
    { key: 'open', header: 'Open', width: '90px', render: (p) => <span>{p.open}{p.overdue > 0 && <span className="text-red-600 text-[11.5px]"> · {p.overdue} late</span>}</span> },
    { key: 'last12', header: 'Last 12 months', width: '140px', render: (p) => <span className="text-[12.5px]"><span className="text-emerald-600">{p.completed12m} done</span> · <span className={p.missed12m ? 'text-red-600' : 'text-muted'}>{p.missed12m} missed</span></span> },
    { key: 'owner', header: 'Owner', width: '160px', render: (p) => <span className="text-[13px]">{p.engineerName ?? p.teamName ?? <span className="text-subtle">—</span>}</span> },
    { key: 'entitlement', header: 'Entitlement', width: '150px', render: (p) => <span className="text-[12.5px]">{p.entitlementName ?? <span className="text-subtle">not metered</span>}</span> },
    { key: 'active', header: 'Active', width: '80px', render: (p) => <Badge color={p.isActive ? 'green' : 'gray'} dot>{p.isActive ? 'Yes' : 'No'}</Badge> },
  ];

  // ------------------------------------------------------------ rail & chips
  const applied: AppliedFilter[] = [];
  if (listView && state.status !== DEFAULTS.status) applied.push({ key: 'status', label: `Status: ${statuses.map((s) => PM_STATUS_LABELS[s as PmStatus] ?? s).join(', ') || 'any'}`, onRemove: () => set({ status: undefined }) });
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.customerId) applied.push({ key: 'customerId', label: `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, onRemove: () => set({ customerId: undefined, siteId: undefined, programId: undefined }) });
  if (state.siteId) applied.push({ key: 'siteId', label: `Site: ${sites.data?.find((s) => s.id === state.siteId)?.name ?? '…'}`, onRemove: () => set({ siteId: undefined }) });
  if (state.programId && tab === 'schedule') applied.push({ key: 'programId', label: `Programme: ${programPicker.data?.items.find((p) => p.id === state.programId)?.name ?? '…'}`, onRemove: () => set({ programId: undefined }) });
  if (state.engineerId) applied.push({ key: 'engineerId', label: `${tab === 'programs' ? 'Owner' : 'Engineer'}: ${engineers.data?.find((u) => u.id === state.engineerId)?.name ?? '…'}`, onRemove: () => set({ engineerId: undefined }) });
  if (state.teamId) applied.push({ key: 'teamId', label: `Team: ${teams.find((t) => t.id === state.teamId)?.name ?? '…'}`, onRemove: () => set({ teamId: undefined }) });
  if (tab === 'programs' && state.frequency) applied.push({ key: 'frequency', label: `Frequency: ${FREQUENCY_LABELS[state.frequency as PmFrequency] ?? state.frequency}`, onRemove: () => set({ frequency: undefined }) });
  if (tab === 'programs' && state.isActive) applied.push({ key: 'isActive', label: state.isActive === 'true' ? 'Active programs' : 'Inactive programs', onRemove: () => set({ isActive: undefined }) });
  if (listView && (state.from || state.to)) applied.push({ key: 'dates', label: `Due ${state.from ? `from ${fmtDate(state.from)}` : ''}${state.from && state.to ? ' ' : ''}${state.to ? `to ${fmtDate(state.to)}` : ''}`, onRemove: () => set({ from: undefined, to: undefined }) });
  if (listView && state.overdue === 'true') applied.push({ key: 'overdue', label: 'Overdue', onRemove: () => set({ overdue: undefined }) });
  if (tab === 'schedule' && state.mine === 'true') applied.push({ key: 'mine', label: 'Assigned to me', onRemove: () => set({ mine: undefined }) });

  const s = summary.data;
  const filters = tab === 'performance' ? undefined : (
    <>
      {listView && (
        <FilterGroup label="Status">
          <FilterOptions multi options={PM_STATUSES.map((st: PmStatus) => ({ value: st, label: PM_STATUS_LABELS[st], dot: dotClass(PM_STATUS_COLORS[st]), count: s?.counts[st] ?? 0 }))} value={statuses} onChange={(v) => set({ status: Array.isArray(v) ? v.join(',') : v })} />
        </FilterGroup>
      )}
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined, programId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Site">
        <FilterSelect value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder={state.customerId ? 'All sites' : 'Choose a customer first'} options={(sites.data ?? []).map((st) => ({ value: st.id, label: st.name }))} />
      </FilterGroup>
      {tab === 'schedule' && (
        <FilterGroup label="Programme">
          <FilterSelect value={state.programId ?? ''} onChange={(e) => set({ programId: e.target.value })} placeholder="All programmes" options={(programPicker.data?.items ?? []).map((p) => ({ value: p.id, label: state.customerId ? p.name : `${p.name}${p.customerName ? ` · ${p.customerName}` : ''}` }))} />
        </FilterGroup>
      )}
      <FilterGroup label={tab === 'programs' ? 'Owner' : 'Engineer'}>
        <FilterSelect value={state.engineerId ?? ''} onChange={(e) => set({ engineerId: e.target.value, mine: undefined })} placeholder="Any engineer" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        <FilterSelect value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Any team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
        {tab === 'schedule' && <FilterToggle label="Assigned to me" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined, engineerId: undefined })} />}
      </FilterGroup>
      {tab === 'programs' && (
        <>
          <FilterGroup label="Frequency">
            <FilterOptions options={frequencies.map((k) => ({ value: k, label: FREQUENCY_LABELS[k] }))} value={state.frequency} onChange={(v) => set({ frequency: v as string | undefined })} />
          </FilterGroup>
          <FilterGroup label="Active">
            <FilterOptions options={[{ value: 'true', label: 'Active only' }, { value: 'false', label: 'Inactive only' }]} value={state.isActive} onChange={(v) => set({ isActive: v as string | undefined })} />
          </FilterGroup>
        </>
      )}
      {listView && (
        <FilterGroup label="Due date">
          <FilterDateRange from={state.from} to={state.to} onChange={(r) => set({ from: r.from, to: r.to })} />
          <FilterToggle label="Overdue" hint="Planned date passed and not done" checked={state.overdue === 'true'} onChange={(v) => set({ overdue: v ? 'true' : undefined })} />
        </FilterGroup>
      )}
    </>
  );

  const countLabel = listView && occurrences.data ? `${fmtNumber(occurrences.data.total)} ${occurrences.data.total === 1 ? 'occurrence' : 'occurrences'}` : tab === 'programs' && programs.data ? `${fmtNumber(programs.data.total)} ${programs.data.total === 1 ? 'program' : 'programs'}` : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Preventive maintenance"
        subtitle={s ? <span>{s.counts.planned + s.counts.scheduled + s.counts.rescheduled} open · {s.overdue.length} overdue · {s.counts.completed} completed · on-time {fmtPct(s.onTimePct, 0)}</span> : 'Recurring maintenance programs and their schedule'}
        actions={canManage ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setNewProgram(true)}>New program</Button> : undefined}
      />

      <ListShell
        id="maintenance"
        modules={FIELD_MODULES}
        search={tab === 'performance' ? undefined : { value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search program…' }}
        filters={filters}
        activeCount={tab === 'performance' ? 0 : activeFilterCount}
        onClear={clearFilters}
        applied={tab === 'performance' ? [] : applied}
        count={countLabel}
        quick={
          <>
            <Segmented size="sm" options={TABS} value={tab} onChange={(t) => set({ tab: t, page: undefined }, false)} />
            {listView &&
              PM_STATUSES.map((st: PmStatus) => (
                <FilterChip key={st} active={statuses.includes(st)} onClick={() => toggleStatus(st)} dot={dotClass(PM_STATUS_COLORS[st])} count={s?.counts[st] ?? 0}>
                  {PM_STATUS_LABELS[st]}
                </FilterChip>
              ))}
          </>
        }
        toolbar={tab === 'schedule' ? <Segmented size="sm" options={[{ value: 'list', label: <span className="inline-flex items-center gap-1.5"><ListIcon className="h-3.5 w-3.5" />List</span> }, { value: 'calendar', label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Calendar</span> }]} value={calendarView ? 'calendar' : 'list'} onChange={(v) => set({ view: v === 'calendar' ? 'calendar' : undefined }, false)} /> : undefined}
        insights={
          tab !== 'performance' ? (
            <InsightBand
              id="maintenance"
              loading={summary.isLoading}
              columns={5}
              summary={s ? `${fmtNumber(s.counts.total)} occurrences · ${fmtDate(s.range.from)} – ${fmtDate(s.range.to)}` : undefined}
              kpis={
                s
                  ? [
                      { label: 'Overdue', value: fmtNumber(s.overdue.length), tone: s.overdue.length ? 'bad' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'planned date passed, not done', onClick: () => set({ tab: 'schedule', view: undefined, overdue: 'true', status: 'planned,scheduled,rescheduled' }), active: state.overdue === 'true' },
                      { label: 'Due in 30 days', value: fmtNumber(s.upcoming.length), icon: <CalendarDays className="h-4 w-4" />, hint: 'coming up next', onClick: () => set({ tab: 'schedule', view: undefined, overdue: undefined, status: 'planned,scheduled,rescheduled', from: ymd(new Date()), to: ymd(new Date(Date.now() + 30 * 86_400_000)) }) },
                      { label: 'Missed · 12 mo', value: fmtNumber(s.counts.missed), tone: s.counts.missed ? 'bad' : 'good', icon: <CalendarX2 className="h-4 w-4" />, hint: 'never completed', onClick: () => set({ tab: 'schedule', view: undefined, status: 'missed', from: undefined, to: undefined, overdue: undefined }), active: state.status === 'missed' },
                      { label: 'Completed · 12 mo', value: fmtNumber(s.counts.completed), tone: 'good', icon: <BadgeCheck className="h-4 w-4" />, hint: `completion ${fmtPct(s.completionPct, 0)}`, onClick: () => set({ tab: 'schedule', view: undefined, status: 'completed', from: undefined, to: undefined, overdue: undefined }), active: state.status === 'completed' },
                      { label: 'On time', value: fmtPct(s.onTimePct, 0), tone: s.onTimePct === null ? 'default' : s.onTimePct >= 90 ? 'good' : s.onTimePct >= 80 ? 'warn' : 'bad', icon: <CheckCircle2 className="h-4 w-4" />, hint: 'completed within the grace window', onClick: () => set({ tab: 'performance' }, false) },
                    ]
                  : []
              }
              panels={
                s && (
                  <>
                    <Panel title="Occurrences by status" subtitle="Click a status to filter the schedule">
                      <BreakdownBar dense items={PM_STATUSES.map((st) => ({ label: PM_STATUS_LABELS[st], value: s.counts[st] ?? 0, color: PM_STATUS_COLORS[st], active: statuses.length === 1 && statuses[0] === st })).filter((i) => i.value > 0)} onSelect={(i) => { const st = PM_STATUSES.find((x) => PM_STATUS_LABELS[x] === i.label); if (st) set({ tab: 'schedule', view: undefined, status: st, overdue: undefined }); }} />
                    </Panel>
                    <Panel title="On-time completion" subtitle="Share of completed occurrences done within the grace window">
                      <div className="flex items-center justify-center py-2">
                        <SlaGauge pct={s.onTimePct} met={s.counts.completed} breached={s.counts.missed} label="On time" target={90} metLabel="completed" breachedLabel="missed" />
                      </div>
                    </Panel>
                  </>
                )
              }
            />
          ) : undefined
        }
      >
        {listView && (
          <div className="card overflow-hidden">
            <DataTable columns={occColumns} rows={occurrences.data?.items ?? []} loading={occurrences.isLoading} dense rowClassName={(o) => (o.status === 'missed' || (o.overdue && o.status !== 'completed' && o.status !== 'cancelled') ? 'row-rail-bad' : o.dueSoon && o.status !== 'completed' ? 'row-rail-warn' : undefined)} sort={{ key: state.sort ?? 'plannedDate', order: (state.order as 'asc' | 'desc') ?? 'asc' }} onSort={(key) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false)} empty={<div className="py-10 text-center"><div className="font-medium">No occurrences match these filters</div><div className="text-[13px] text-muted mt-1">Adjust the filters or <button className="text-brand-600 hover:underline" onClick={clearFilters}>clear them</button>.</div></div>} />
            <Pagination page={page} pageSize={pageSize} total={occurrences.data?.total ?? 0} onPage={setPage} />
            {occurrences.isError && <div className="px-3 py-2 text-[12.5px] text-red-600">{(occurrences.error as Error).message}</div>}
          </div>
        )}
        {calendarView && (
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
      </ListShell>

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
              <span className={cn('w-24 shrink-0 tabular-nums', tone === 'bad' && 'text-red-600 font-medium')}>{fmtDate(o.effectiveDate)}</span>
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
  const chip: Record<string, string> = { planned: 'bg-slate-100 text-slate-700', scheduled: 'bg-blue-50 text-blue-800', rescheduled: 'bg-indigo-50 text-indigo-800', completed: 'bg-emerald-50 text-emerald-800', missed: 'bg-red-50 text-red-800', cancelled: 'bg-gray-50 text-gray-500 line-through' };
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-default">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => onMonthChange(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>This month</Button>
          <Button variant="ghost" size="icon" onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-2 text-[13px] font-medium">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-muted">{(['planned', 'scheduled', 'completed', 'missed'] as PmStatus[]).map((st) => <span key={st} className="inline-flex items-center gap-1"><span className={cn('h-2.5 w-2.5 rounded-sm', LEGEND[st])} />{PM_STATUS_LABELS[st]}</span>)}{loading && <span>· loading…</span>}</div>
      </div>
      <div className="grid grid-cols-7 bg-surface-2 border-b border-default">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-2 py-1 text-[10.5px] uppercase tracking-wide text-subtle font-medium text-center">{d}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = ymd(d);
          const list = byDay.get(key) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div key={key} className={cn('min-h-[88px] border-b border-r border-default p-1 flex flex-col gap-1', !inMonth && 'bg-surface-2/40', key === today && 'bg-brand-50/40')}>
              <div className={cn('text-[11px] text-right', inMonth ? 'text-muted' : 'text-subtle', key === today && 'font-semibold text-brand-700')}>{d.getDate()}</div>
              {list.slice(0, 4).map((o) => (
                <button key={o.id} onClick={() => onSelect(o)} className={cn('text-left rounded px-1.5 py-0.5 text-[11px] leading-tight truncate hover:brightness-95', chip[o.status] ?? chip.planned)} title={`${o.programName} · ${o.customerName ?? ''} · ${PM_STATUS_LABELS[o.status]}`}>
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
