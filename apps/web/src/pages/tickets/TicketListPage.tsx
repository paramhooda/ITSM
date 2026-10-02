import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Bookmark, Trash2, Share2, AlertTriangle, Flame, ChevronDown, Inbox, Timer, UserX, UserCheck } from 'lucide-react';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar, type BreakdownItem } from '@/components/dashboards/BreakdownBar';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { PageHeader, Button, Select, SearchInput, DataTable, Pagination, Dialog, Input, Checkbox, Avatar, Kbd, FilterBar, FilterChip, type Column } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { relativeTime, fmtDateTime, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { TICKET_CATEGORY_COLORS, PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { ticketsApi, qk, itemsOf } from '@/components/tickets/api';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { ScopeBadge } from '@/components/tickets/ScopeBadge';
import { SlaIndicator, slaTone } from '@/components/tickets/SlaIndicator';
import type { TicketListRow, TicketType, SavedView } from '@/components/tickets/types';

type Tab = 'all' | TicketType;
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'incident', label: 'Incidents' },
  { key: 'request', label: 'Requests' },
  { key: 'problem', label: 'Problems' },
  { key: 'change', label: 'Changes' },
];
const STATUS_CATEGORIES = [
  { key: 'new', label: 'New' },
  { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
];
const FILTER_KEYS = ['q', 'customerId', 'statusCategory', 'priorityId', 'assignee', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'createdFrom', 'createdTo', 'isMajor', 'type', 'sort', 'order'];
const DEFAULTS = { statusCategory: 'new,open,pending', sort: 'lastActivityAt', order: 'desc' };
type Breakdown = 'priority' | 'status' | 'team';

/** A breached SLA gets a red rail, a clock past 75% an amber one; everything else stays quiet. */
const rowRail = (r: TicketListRow) => {
  const tone = slaTone(r.sla);
  if (r.sla?.state === 'met' || r.sla?.state === 'cancelled') return undefined;
  return tone === 'bad' ? 'row-rail-bad' : tone === 'warn' ? 'row-rail-warn' : undefined;
};

export default function TicketListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const user = useAuthStore((s) => s.user)!;
  const can = useAuthStore((s) => s.can);
  const [saveOpen, setSaveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [breakdown, setBreakdown] = useState<Breakdown>('priority');

  const tab = (state.type as Tab) || 'all';
  const assigneeFilter = state.assignee ?? '';
  const filterParams = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (state.q) p.q = state.q;
    if (tab !== 'all') p.type = tab;
    for (const k of ['customerId', 'statusCategory', 'priorityId', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'createdFrom', 'createdTo'] as const) if (state[k]) p[k] = state[k];
    if (state.isMajor === 'true') p.isMajor = 'true';
    if (assigneeFilter === 'me') p.mine = 'true';
    else if (assigneeFilter === 'unassigned') p.unassigned = 'true';
    else if (assigneeFilter === 'watching') p.watching = 'true';
    else if (assigneeFilter) p.assigneeId = assigneeFilter;
    return p;
  }, [state, tab, assigneeFilter]);
  const params = useMemo(() => ({ ...filterParams, page, pageSize, sort: state.sort, order: state.order }), [filterParams, page, pageSize, state.sort, state.order]);

  const list = useQuery({ queryKey: qk.list(params), queryFn: () => ticketsApi.list(params), placeholderData: (prev) => prev });
  // Stats honour the same filters as the list, so the band above the table always describes what is in it.
  const stats = useQuery({ queryKey: qk.stats(filterParams), queryFn: () => ticketsApi.stats(filterParams), refetchInterval: 60_000, placeholderData: (prev) => prev });
  const views = useQuery({ queryKey: qk.views, queryFn: () => ticketsApi.views() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && can('tickets:create')) {
        e.preventDefault();
        navigate('/tickets/new');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, can]);

  const cats = (state.statusCategory ?? '').split(',').filter(Boolean);
  const toggleCat = (key: string) => {
    const next = cats.includes(key) ? cats.filter((c) => c !== key) : [...cats, key];
    set({ statusCategory: next.join(',') });
  };
  const activeFilterCount = ['q', 'customerId', 'priorityId', 'assignee', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'createdFrom', 'createdTo', 'isMajor'].filter((k) => state[k]).length + (state.statusCategory !== DEFAULTS.statusCategory ? 1 : 0) + (tab !== 'all' ? 1 : 0);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const applyView = (v: SavedView) => {
    const patch: Record<string, string | undefined> = Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined]));
    for (const [k, val] of Object.entries(v.filters)) if (val !== undefined && val !== null && val !== '') patch[k] = String(val);
    if (v.sort) {
      const [s, o] = v.sort.split(':');
      patch.sort = s;
      patch.order = o ?? 'desc';
    }
    set(patch);
  };
  const saveView = useMutation({
    mutationFn: (input: { name: string; isShared: boolean }) => {
      const filters: Record<string, unknown> = {};
      for (const k of FILTER_KEYS) if (state[k] && k !== 'sort' && k !== 'order') filters[k] = state[k];
      return ticketsApi.createView({ name: input.name, entity: 'ticket', filters, sort: `${state.sort}:${state.order}`, isShared: input.isShared });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.views });
      setSaveOpen(false);
      toast.success('View saved');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => ticketsApi.deleteView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.views }),
    onError: (e: Error) => toast.error(e.message),
  });
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => ticketsApi.bulk({ ...body, ids: [...selected] }),
    onSuccess: (r) => {
      toast.success(`${r.succeeded} updated${r.failed ? `, ${r.failed} failed` : ''}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = list.data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const canBulk = can('tickets:assign') || can('tickets:update');

  const columns: Column<TicketListRow>[] = [
    ...(canBulk
      ? [{ key: 'sel', header: <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" className="h-3.5 w-3.5 accent-brand-600" />, width: '32px', render: (r: TicketListRow) => <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} onClick={(e) => e.stopPropagation()} aria-label="Select" className="h-3.5 w-3.5 accent-brand-600" /> }]
      : []),
    {
      key: 'number',
      header: 'Number',
      sortable: true,
      width: '130px',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Link to={`/tickets/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12.5px] font-medium text-brand-700 hover:underline whitespace-nowrap">
            {r.number}
          </Link>
          {tab === 'all' && <TypeBadge type={r.type} short className="px-1 py-0 text-[10px]" />}
        </div>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      render: (r) => (
        <div className="min-w-[220px] max-w-[520px]">
          <div className="flex items-center gap-1.5 min-w-0">
            {r.isMajor && <Flame className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label="Major incident" />}
            {r.escalationLevel > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" aria-label={`Escalation level ${r.escalationLevel}`} />}
            <span className="truncate font-medium text-[13.5px]">{r.title}</span>
          </div>
          <div className="text-[11.5px] text-muted truncate">
            {r.customerName ?? '—'}
            {r.siteName ? ` · ${r.siteName}` : ''}
            {r.serviceName ? ` · ${r.serviceName}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'priority', header: 'Priority', sortable: true, width: '110px', render: (r) => <PriorityBadge priority={r.priority} compact /> },
    { key: 'status', header: 'Status', sortable: true, width: '140px', render: (r) => <TicketStatusBadge status={r.status} /> },
    { key: 'dueAt', header: 'SLA', sortable: true, width: '120px', render: (r) => <SlaIndicator sla={r.sla} /> },
    { key: 'scope', header: 'Scope', width: '110px', render: (r) => <ScopeBadge status={r.scopeStatus} short={false} /> },
    {
      key: 'assignee',
      header: 'Assignee',
      width: '170px',
      render: (r) =>
        r.assigneeName ? (
          <div className="flex items-center gap-2 min-w-0">
            <Avatar name={r.assigneeName} size="xs" />
            <span className="truncate text-[13px]">{r.assigneeName}</span>
          </div>
        ) : (
          <span className="text-[12.5px] text-subtle">{r.teamName ? `${r.teamName} · unassigned` : 'Unassigned'}</span>
        ),
    },
    { key: 'lastActivityAt', header: 'Updated', sortable: true, width: '110px', render: (r) => <span className="text-[12.5px] text-muted whitespace-nowrap" title={fmtDateTime(r.lastActivityAt)}>{relativeTime(r.lastActivityAt)}</span> },
  ];

  const s = stats.data;
  const byType = s?.byType ?? {};
  const openTotal = s?.open ?? 0;
  const teams = lookups?.teams ?? [];
  const services = lookups?.services ?? [];
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const series = s?.series ?? [];

  const breakdownItems: BreakdownItem[] = useMemo(() => {
    if (!s) return [];
    if (breakdown === 'priority') return (s.byPriority ?? []).map((p) => ({ label: p.label, value: p.count, color: p.color ?? (p.level ? PRIORITY_LEVEL_COLORS[p.level] : null), active: !!p.id && state.priorityId === p.id }));
    if (breakdown === 'status') return (s.byStatus ?? []).map((st) => ({ label: st.label, value: st.count, color: st.color ?? TICKET_CATEGORY_COLORS[st.category ?? ''] ?? null }));
    return (s.byTeam ?? []).map((t) => ({ label: t.label, value: t.count, secondary: t.breached, secondaryLabel: 'breached', active: !!t.id && state.teamId === t.id }));
  }, [s, breakdown, state.priorityId, state.teamId]);
  const onBreakdownSelect = (item: BreakdownItem) => {
    if (breakdown === 'priority') {
      const p = s?.byPriority.find((x) => x.label === item.label);
      if (p?.id) set({ priorityId: state.priorityId === p.id ? undefined : p.id });
    } else if (breakdown === 'team') {
      const t = s?.byTeam.find((x) => x.label === item.label);
      if (t?.id) set({ teamId: state.teamId === t.id ? undefined : t.id });
    } else {
      const st = s?.byStatus.find((x) => x.label === item.label);
      if (st?.category) set({ statusCategory: st.category });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tickets"
        subtitle={s ? <span>{fmtNumber(s.total)} match the current filters · {fmtNumber(s.breached)} breached · {fmtNumber(s.unassigned)} unassigned</span> : 'Incidents, requests, problems and changes across every customer'}
        actions={
          <>
            <Menu
              trigger={
                <Button variant="outline" size="sm" icon={<Bookmark className="h-3.5 w-3.5" />}>
                  Views <ChevronDown className="h-3 w-3" />
                </Button>
              }
              items={[
                ...(views.data?.items ?? []).map((v) => ({
                  label: (
                    <span className="flex items-center gap-2 w-full">
                      <span className="flex-1 truncate">{v.name}</span>
                      {v.isShared && <Share2 className="h-3 w-3 text-subtle" />}
                      {v.isOwner && (
                        <span
                          role="button"
                          className="text-subtle hover:text-red-600"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete view "${v.name}"?`)) deleteView.mutate(v.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </span>
                      )}
                    </span>
                  ),
                  onClick: () => applyView(v),
                })),
                { label: 'Save current filters…', icon: <Plus className="h-3.5 w-3.5" />, onClick: () => setSaveOpen(true) },
              ]}
            />
            {can('tickets:create') && (
              <Button onClick={() => navigate('/tickets/new')} icon={<Plus className="h-4 w-4" />} size="sm">
                New ticket <Kbd>n</Kbd>
              </Button>
            )}
          </>
        }
      />

      {/* 1. Filters */}
      <FilterBar
        activeCount={activeFilterCount}
        onClear={clearFilters}
        chips={
          <>
            {STATUS_CATEGORIES.map((c) => (
              <FilterChip key={c.key} active={cats.includes(c.key)} onClick={() => toggleCat(c.key)} dot={dotClass(TICKET_CATEGORY_COLORS[c.key])} count={s?.byStatusCategory?.[c.key] ?? 0}>
                {c.label}
              </FilterChip>
            ))}
            {selected.size > 0 && canBulk && (
              <div className="ml-auto flex items-center gap-2 text-[12.5px]">
                <span className="text-muted">{selected.size} selected</span>
                {can('tickets:assign') && (
                  <Select className="h-7 py-0 w-40 text-[12.5px]" placeholder="Assign to…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'assign', payload: { assigneeId: e.target.value } })}>
                    {(engineers.data ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                )}
                {can('tickets:update') && <Select className="h-7 py-0 w-36 text-[12.5px]" placeholder="Set priority…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'priority', payload: { priorityId: e.target.value } })} options={options('ticket_priority').map((o) => ({ value: o.id, label: o.label }))} />}
                {can('tickets:update') && <Select className="h-7 py-0 w-40 text-[12.5px]" placeholder="Set status…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', payload: { statusId: e.target.value } })} options={options('ticket_status', tab !== 'all' ? { ticketType: tab } : undefined).map((o) => ({ value: o.id, label: o.label }))} />}
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </>
        }
      >
        <Segmented size="sm" options={TABS.map((t) => ({ value: t.key, label: t.label, count: t.key === 'all' ? openTotal : (byType[t.key] ?? 0) }))} value={tab} onChange={(v) => set({ type: v === 'all' ? undefined : v })} />
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search number, title, description…" className="w-64" />
        <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" className="w-44 h-8 py-0 text-[13px]" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
        <Select value={state.priorityId ?? ''} onChange={(e) => set({ priorityId: e.target.value })} placeholder="Priority" className="w-32 h-8 py-0 text-[13px]" options={options('ticket_priority').map((o) => ({ value: o.id, label: o.label }))} />
        <Select value={assigneeFilter} onChange={(e) => set({ assignee: e.target.value })} placeholder="Assignee" className="w-40 h-8 py-0 text-[13px]">
          <option value="me">Mine</option>
          <option value="unassigned">Unassigned</option>
          <option value="watching">Watching</option>
          {(engineers.data ?? []).filter((u) => u.id !== user.id).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Team" className="w-36 h-8 py-0 text-[13px]" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
        <Select value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Service" className="w-40 h-8 py-0 text-[13px]" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
        <Select value={state.scopeStatus ?? ''} onChange={(e) => set({ scopeStatus: e.target.value })} placeholder="Scope" className="w-32 h-8 py-0 text-[13px]" options={[{ value: 'in_scope', label: 'In scope' }, { value: 'out_of_scope', label: 'Out of scope' }, { value: 'unknown', label: 'Unknown' }]} />
        <Select value={state.slaState ?? ''} onChange={(e) => set({ slaState: e.target.value })} placeholder="SLA" className="w-28 h-8 py-0 text-[13px]" options={[{ value: 'breached', label: 'Breached' }, { value: 'at_risk', label: 'At risk' }, { value: 'ok', label: 'On track' }]} />
        <Input type="date" value={state.createdFrom ?? ''} onChange={(e) => set({ createdFrom: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Created from" aria-label="Created from" />
        <Input type="date" value={state.createdTo ?? ''} onChange={(e) => set({ createdTo: e.target.value })} className="w-36 h-8 py-0 text-[13px]" title="Created to" aria-label="Created to" />
        <Checkbox checked={state.isMajor === 'true'} onChange={(e) => set({ isMajor: e.target.checked ? 'true' : undefined })} label={<span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5 text-red-500" /> Major</span>} />
      </FilterBar>

      {/* 2. Insights for the filtered set */}
      <InsightBand
        id="tickets"
        loading={stats.isLoading}
        summary={s ? `${fmtNumber(s.total)} tickets match` : undefined}
        kpis={
          s
            ? [
                { label: 'Open tickets', value: fmtNumber(s.open), icon: <Inbox className="h-4 w-4" />, hint: `${fmtNumber(s.createdToday)} opened today · ${fmtNumber(s.resolvedToday)} resolved`, spark: series.map((d) => d.opened), sparkLabel: 'Tickets opened per day', onClick: () => set({ statusCategory: DEFAULTS.statusCategory, slaState: undefined, assignee: undefined }) },
                { label: 'SLA breached', value: fmtNumber(s.breached), tone: s.breached > 0 ? 'bad' : 'good', icon: <Timer className="h-4 w-4" />, hint: `${fmtNumber(s.atRisk)} at risk · ${fmtNumber(s.overdue)} overdue`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, slaState: state.slaState === 'breached' ? undefined : 'breached' }) },
                { label: 'Unassigned', value: fmtNumber(s.unassigned), tone: s.unassigned > 0 ? 'warn' : 'good', icon: <UserX className="h-4 w-4" />, hint: `${fmtNumber(s.major)} major open`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, assignee: assigneeFilter === 'unassigned' ? undefined : 'unassigned' }) },
                { label: 'Assigned to me', value: fmtNumber(s.mine), icon: <UserCheck className="h-4 w-4" />, hint: `${fmtNumber(s.dueToday)} due today · ${fmtNumber(s.pendingApprovals)} awaiting approval`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, assignee: assigneeFilter === 'me' ? undefined : 'me' }) },
              ]
            : []
        }
        panels={
          s && (
            <>
              <Panel title="Ticket flow" subtitle={state.createdFrom && state.createdTo ? 'Opened and resolved per day in the selected range' : 'Opened and resolved per day, last 14 days'}>
                <TrendChart data={series} x="day" series={[{ key: 'opened', label: 'Opened', color: '#2563eb' }, { key: 'resolved', label: 'Resolved', color: '#0f9d6f' }]} kind="area" height={190} />
              </Panel>
              <Panel title="Breakdown" subtitle="Click a row to filter" action={<Segmented size="sm" options={[{ value: 'priority', label: 'Priority' }, { value: 'status', label: 'Status' }, { value: 'team', label: 'Team' }]} value={breakdown} onChange={setBreakdown} />}>
                <BreakdownBar items={breakdownItems} dense emptyText="No tickets in this view" onSelect={onBreakdownSelect} />
              </Panel>
            </>
          )
        }
      />

      {/* 3. The list */}
      <div className="card overflow-hidden">
        <DataTable
          columns={columns}
          rows={rows}
          loading={list.isLoading}
          dense
          rowClassName={rowRail}
          onRowClick={(r) => navigate(`/tickets/${r.id}`)}
          sort={{ key: state.sort === 'dueAt' ? 'dueAt' : state.sort ?? 'lastActivityAt', order: (state.order as 'asc' | 'desc') ?? 'desc' }}
          onSort={(key) => {
            const sortKey = key === 'assignee' ? undefined : key;
            if (!sortKey) return;
            set({ sort: sortKey, order: state.sort === sortKey && state.order === 'desc' ? 'asc' : 'desc' }, false);
          }}
          empty={
            <div className="py-10 text-center">
              <div className="font-medium">No tickets match these filters</div>
              <div className="text-[13px] text-muted mt-1">Adjust the filters or <button className="text-brand-600 hover:underline" onClick={clearFilters}>clear them</button>.</div>
            </div>
          }
        />
        <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
      </div>
      {list.isError && <div className="text-[12.5px] text-red-600">{(list.error as Error).message}</div>}

      <SaveViewDialog open={saveOpen} onClose={() => setSaveOpen(false)} onSave={(name, isShared) => saveView.mutate({ name, isShared })} saving={saveView.isPending} />
    </div>
  );
}

function SaveViewDialog({ open, onClose, onSave, saving }: { open: boolean; onClose: () => void; onSave: (name: string, isShared: boolean) => void; saving: boolean }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setShared(false);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save view"
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => name.trim() && onSave(name.trim(), shared)} loading={saving} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input autoFocus placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim(), shared)} />
        <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label="Share with all MSP users" />
        <div className="text-[12px] text-subtle">Saves the current filters, status chips and sort order.</div>
      </div>
    </Dialog>
  );
}
