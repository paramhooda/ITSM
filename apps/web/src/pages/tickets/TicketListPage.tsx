import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Bookmark, Trash2, Share2, AlertTriangle, Flame, ChevronDown, Inbox, Timer, UserX, UserCheck, Gauge } from 'lucide-react';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar, type BreakdownItem } from '@/components/dashboards/BreakdownBar';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { PageHeader, Button, Select, DataTable, Pagination, Dialog, Input, Checkbox, Avatar, Kbd, FilterChip, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle, type AppliedFilter, type Column } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { relativeTime, fmtDateTime, fmtNumber, fmtDate } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { TICKET_CATEGORY_COLORS, PRIORITY_LEVEL_COLORS, SCOPE_COLORS, BREACH_RISK_COLORS, SENTIMENT_COLORS } from '@/lib/statusColors';
import { DOMAINS } from '@itsm/shared';
import { ticketsApi, qk, itemsOf } from '@/components/tickets/api';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { ScopeBadge } from '@/components/tickets/ScopeBadge';
import { SlaIndicator, slaTone } from '@/components/tickets/SlaIndicator';
import { RiskBadge, SentimentBadge, isUnhappy } from '@/components/tickets/RiskBadge';
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
const SCOPE_OPTIONS = [
  { value: 'in_scope', label: 'In scope' },
  { value: 'out_of_scope', label: 'Out of scope' },
  { value: 'unknown', label: 'Unknown' },
];
const SLA_OPTIONS = [
  { value: 'breached', label: 'Breached', color: 'red' },
  { value: 'at_risk', label: 'At risk', color: 'amber' },
  { value: 'ok', label: 'On track', color: 'green' },
];
const RISK_OPTIONS = [
  { value: 'high', label: 'Likely to breach' },
  { value: 'medium', label: 'Medium risk' },
  { value: 'low', label: 'Low risk' },
];
const SENTIMENT_OPTIONS = [
  { value: 'unhappy', label: 'Unhappy or angry', color: 'red' },
  { value: 'neutral', label: 'Neutral', color: 'slate' },
  { value: 'positive', label: 'Happy', color: 'green' },
];
/** The assignee key carries either one of these views or an engineer id. */
const ASSIGNEE_VIEWS = [
  { value: 'me', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'watching', label: 'Watching' },
];
const DOMAIN_LABELS: Record<string, string> = { general: 'General', noc: 'NOC', soc: 'SOC', amc: 'AMC', service_desk: 'Service desk' };
/** Every filter the page owns; sort/order live beside them in the URL but are not filters. */
const FILTER_KEYS = ['q', 'customerId', 'statusCategory', 'priorityId', 'assignee', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'breachRisk', 'sentiment', 'createdFrom', 'createdTo', 'isMajor', 'type', 'domain', 'categoryId', 'securitySeverityId'];
const DEFAULTS = { statusCategory: 'new,open,pending', sort: 'lastActivityAt', order: 'desc' };
/**
 * Parameters that dashboards and record pages link with (`mine=true`, `open=true`,
 * `assigneeId=…`, `status=resolved`, `contractId=…`). They are rewritten into the
 * page's own keys on arrival so one set of chips and rail controls describes the list.
 */
const LEGACY_KEYS = ['mine', 'unassigned', 'open', 'assigneeId', 'status', 'contractId'];
type Breakdown = 'priority' | 'status' | 'team';

function legacyPatch(state: Record<string, string>): Record<string, string | undefined> | null {
  if (!LEGACY_KEYS.some((k) => k in state)) return null;
  const patch: Record<string, string | undefined> = Object.fromEntries(LEGACY_KEYS.map((k) => [k, undefined]));
  if (!state.assignee) {
    if (state.mine === 'true') patch.assignee = 'me';
    else if (state.unassigned === 'true') patch.assignee = 'unassigned';
    else if (state.assigneeId) patch.assignee = state.assigneeId;
  }
  // status=open means the open categories, which is the page default; the others name one category.
  if (state.status && state.statusCategory === DEFAULTS.statusCategory) {
    const cat = state.status === 'awaiting' ? 'pending' : state.status;
    if (STATUS_CATEGORIES.some((c) => c.key === cat)) patch.statusCategory = cat;
  }
  // open=true is the default view; contractId has no list filter, so it is dropped silently.
  return patch;
}

const dateRangeLabel = (from?: string, to?: string) => (from && to ? `${fmtDate(from)} – ${fmtDate(to)}` : from ? `from ${fmtDate(from)}` : `until ${fmtDate(to)}`);

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
  const { options, lookups, byId } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const user = useAuthStore((s) => s.user)!;
  const can = useAuthStore((s) => s.can);
  const [saveOpen, setSaveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [breakdown, setBreakdown] = useState<Breakdown>('priority');

  // Links from dashboards arrive with legacy keys; normalise them once, then query.
  const legacy = useMemo(() => legacyPatch(state), [state]);
  useEffect(() => {
    if (legacy) set(legacy, false);
  }, [legacy, set]);

  const tab = (state.type as Tab) || 'all';
  const assigneeFilter = state.assignee ?? '';
  const filterParams = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (state.q) p.q = state.q;
    if (tab !== 'all') p.type = tab;
    for (const k of ['customerId', 'statusCategory', 'priorityId', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'breachRisk', 'sentiment', 'createdFrom', 'createdTo', 'domain', 'categoryId', 'securitySeverityId'] as const) if (state[k]) p[k] = state[k];
    if (state.isMajor === 'true') p.isMajor = 'true';
    if (assigneeFilter === 'me') p.mine = 'true';
    else if (assigneeFilter === 'unassigned') p.unassigned = 'true';
    else if (assigneeFilter === 'watching') p.watching = 'true';
    else if (assigneeFilter) p.assigneeId = assigneeFilter;
    return p;
  }, [state, tab, assigneeFilter]);
  const params = useMemo(() => ({ ...filterParams, page, pageSize, sort: state.sort, order: state.order }), [filterParams, page, pageSize, state.sort, state.order]);

  const list = useQuery({ queryKey: qk.list(params), queryFn: () => ticketsApi.list(params), placeholderData: (prev) => prev, enabled: !legacy });
  // Stats honour the same filters as the list, so the band above the table always describes what is in it.
  const stats = useQuery({ queryKey: qk.stats(filterParams), queryFn: () => ticketsApi.stats(filterParams), refetchInterval: 60_000, placeholderData: (prev) => prev, enabled: !legacy });
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
      for (const k of FILTER_KEYS) if (state[k]) filters[k] = state[k];
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
    {
      key: 'risk',
      header: 'Risk',
      width: '100px',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <RiskBadge risk={r.breachRisk} compact quiet />
          {isUnhappy(r.lastSentiment?.sentiment) && <SentimentBadge sentiment={r.lastSentiment?.sentiment} compact />}
          {!r.breachRisk && !isUnhappy(r.lastSentiment?.sentiment) && <span className="text-subtle text-xs">—</span>}
        </span>
      ),
    },
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
  const engineerItems = engineers.data ?? [];
  const priorities = options('ticket_priority');
  const categories = options('ticket_category');
  const securitySeverities = options('security_severity');
  const priorityCounts = new Map((s?.byPriority ?? []).filter((p) => p.id).map((p) => [p.id as string, p.count]));
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

  // Every filter in effect, spelled out above the results; removing one clears only its key(s).
  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (tab !== 'all') addApplied('type', `Type: ${TABS.find((t) => t.key === tab)?.label ?? tab}`);
  if (state.statusCategory !== DEFAULTS.statusCategory) addApplied('statusCategory', `Status: ${cats.map((c) => STATUS_CATEGORIES.find((x) => x.key === c)?.label ?? c).join(', ')}`);
  if (state.priorityId) addApplied('priorityId', `Priority: ${priorities.find((p) => p.id === state.priorityId)?.label ?? '…'}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (assigneeFilter) addApplied('assignee', `Assignee: ${ASSIGNEE_VIEWS.find((v) => v.value === assigneeFilter)?.label ?? engineerItems.find((u) => u.id === assigneeFilter)?.name ?? '…'}`);
  if (state.teamId) addApplied('teamId', `Team: ${teams.find((t) => t.id === state.teamId)?.name ?? '…'}`);
  if (state.serviceId) addApplied('serviceId', `Service: ${services.find((sv) => sv.id === state.serviceId)?.name ?? '…'}`);
  if (state.domain) addApplied('domain', `Domain: ${DOMAIN_LABELS[state.domain] ?? state.domain}`);
  if (state.categoryId) addApplied('categoryId', `Category: ${byId(state.categoryId)?.label ?? '…'}`);
  if (state.securitySeverityId) addApplied('securitySeverityId', `Security severity: ${byId(state.securitySeverityId)?.label ?? '…'}`);
  if (state.scopeStatus) addApplied('scopeStatus', `Scope: ${SCOPE_OPTIONS.find((o) => o.value === state.scopeStatus)?.label ?? state.scopeStatus}`);
  if (state.slaState) addApplied('slaState', `SLA: ${SLA_OPTIONS.find((o) => o.value === state.slaState)?.label ?? state.slaState}`);
  if (state.breachRisk) addApplied('breachRisk', `Breach risk: ${RISK_OPTIONS.find((o) => o.value === state.breachRisk)?.label ?? state.breachRisk}`);
  if (state.sentiment) addApplied('sentiment', `Customer mood: ${SENTIMENT_OPTIONS.find((o) => o.value === state.sentiment)?.label ?? state.sentiment}`);
  if (state.createdFrom || state.createdTo) addApplied('created', `Created: ${dateRangeLabel(state.createdFrom, state.createdTo)}`, ['createdFrom', 'createdTo']);
  if (state.isMajor === 'true') addApplied('isMajor', 'Major incidents only');

  const total = list.data?.total;
  const rail = (
    <>
      <FilterGroup label="Priority">
        <FilterOptions options={priorities.map((o) => ({ value: o.id, label: o.label, dot: dotClass(o.color ?? (o.level ? PRIORITY_LEVEL_COLORS[o.level] : null)), count: s ? priorityCounts.get(o.id) ?? 0 : undefined }))} value={state.priorityId} onChange={(v) => set({ priorityId: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Assignee">
        <FilterOptions options={ASSIGNEE_VIEWS} value={ASSIGNEE_VIEWS.some((v) => v.value === assigneeFilter) ? assigneeFilter : undefined} onChange={(v) => set({ assignee: v as string | undefined })} />
        <FilterSelect value={ASSIGNEE_VIEWS.some((v) => v.value === assigneeFilter) ? '' : assigneeFilter} onChange={(e) => set({ assignee: e.target.value })} placeholder="Any engineer" options={engineerItems.filter((u) => u.id !== user.id).map((u) => ({ value: u.id, label: u.name }))} aria-label="Engineer" />
      </FilterGroup>
      <FilterGroup label="Team">
        <FilterSelect value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} placeholder="Any team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
      </FilterGroup>
      <FilterGroup label="Service">
        <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
      </FilterGroup>
      <FilterGroup label="Scope">
        <FilterOptions options={SCOPE_OPTIONS.map((o) => ({ ...o, dot: dotClass(SCOPE_COLORS[o.value]) }))} value={state.scopeStatus} onChange={(v) => set({ scopeStatus: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="SLA">
        <FilterOptions options={SLA_OPTIONS.map((o) => ({ value: o.value, label: o.label, dot: dotClass(o.color) }))} value={state.slaState} onChange={(v) => set({ slaState: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Breach risk" hint="Forecast from the clock, how long similar tickets take and who owns it" defaultOpen={!!state.breachRisk}>
        <FilterOptions options={RISK_OPTIONS.map((o) => ({ value: o.value, label: o.label, dot: dotClass(BREACH_RISK_COLORS[o.value]) }))} value={state.breachRisk} onChange={(v) => set({ breachRisk: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer mood" hint="From the customer's last comment" defaultOpen={!!state.sentiment}>
        <FilterOptions options={SENTIMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label, dot: dotClass(SENTIMENT_COLORS[o.value] ?? o.color) }))} value={state.sentiment} onChange={(v) => set({ sentiment: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Created">
        <FilterDateRange from={state.createdFrom} to={state.createdTo} onChange={(r) => set({ createdFrom: r.from, createdTo: r.to })} />
      </FilterGroup>
      <FilterGroup label="Domain" defaultOpen={!!state.domain}>
        <FilterOptions options={DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABELS[d] ?? d }))} value={state.domain} onChange={(v) => set({ domain: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Category" defaultOpen={!!state.categoryId}>
        <FilterSelect value={state.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value })} placeholder="Any category" options={categories.map((o) => ({ value: o.id, label: o.label }))} />
      </FilterGroup>
      {securitySeverities.length > 0 && (
        <FilterGroup label="Security severity" defaultOpen={!!state.securitySeverityId}>
          <FilterSelect value={state.securitySeverityId ?? ''} onChange={(e) => set({ securitySeverityId: e.target.value })} placeholder="Any severity" options={securitySeverities.map((o) => ({ value: o.id, label: o.label }))} />
        </FilterGroup>
      )}
      <FilterGroup label="More">
        <FilterToggle
          label={
            <span className="inline-flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-red-500" /> Major incidents only
            </span>
          }
          checked={state.isMajor === 'true'}
          onChange={(v) => set({ isMajor: v ? 'true' : undefined })}
        />
      </FilterGroup>
    </>
  );

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

      <ListShell
        id="tickets"
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search number, title, description…' }}
        filters={rail}
        applied={applied}
        activeCount={applied.length}
        onClear={clearFilters}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'ticket' : 'tickets'}` : undefined}
        quick={
          <>
            <Segmented size="sm" options={TABS.map((t) => ({ value: t.key, label: t.label, count: t.key === 'all' ? openTotal : (byType[t.key] ?? 0) }))} value={tab} onChange={(v) => set({ type: v === 'all' ? undefined : v })} />
            <span className="hidden sm:block h-5 w-px bg-[var(--border)] mx-0.5" aria-hidden />
            {STATUS_CATEGORIES.map((c) => (
              <FilterChip key={c.key} active={cats.includes(c.key)} onClick={() => toggleCat(c.key)} dot={dotClass(TICKET_CATEGORY_COLORS[c.key])} count={s?.byStatusCategory?.[c.key] ?? 0}>
                {c.label}
              </FilterChip>
            ))}
          </>
        }
        toolbar={
          selected.size > 0 && canBulk ? (
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="text-muted">{selected.size} selected</span>
              {can('tickets:assign') && (
                <Select className="h-8 py-0 w-40 text-[12.5px]" placeholder="Assign to…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'assign', payload: { assigneeId: e.target.value } })}>
                  {engineerItems.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              )}
              {can('tickets:update') && <Select className="h-8 py-0 w-36 text-[12.5px]" placeholder="Set priority…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'priority', payload: { priorityId: e.target.value } })} options={priorities.map((o) => ({ value: o.id, label: o.label }))} />}
              {can('tickets:update') && <Select className="h-8 py-0 w-40 text-[12.5px]" placeholder="Set status…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', payload: { statusId: e.target.value } })} options={options('ticket_status', tab !== 'all' ? { ticketType: tab } : undefined).map((o) => ({ value: o.id, label: o.label }))} />}
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : undefined
        }
        insights={
          <InsightBand
            id="tickets"
            loading={stats.isLoading}
            summary={s ? `${fmtNumber(s.total)} tickets match` : undefined}
            columns={5}
            kpis={
              s
                ? [
                    { label: 'Open tickets', value: fmtNumber(s.open), icon: <Inbox className="h-4 w-4" />, hint: `${fmtNumber(s.createdToday)} opened today · ${fmtNumber(s.resolvedToday)} resolved`, spark: series.map((d) => d.opened), sparkLabel: 'Tickets opened per day', onClick: () => set({ statusCategory: DEFAULTS.statusCategory, slaState: undefined, assignee: undefined }), scrollTo: true },
                    { label: 'SLA breached', value: fmtNumber(s.breached), tone: s.breached > 0 ? 'bad' : 'good', icon: <Timer className="h-4 w-4" />, hint: `${fmtNumber(s.atRisk)} at risk · ${fmtNumber(s.overdue)} overdue`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, slaState: state.slaState === 'breached' ? undefined : 'breached' }), scrollTo: true, active: state.slaState === 'breached' },
                    { label: 'Likely to breach', value: fmtNumber(s.highRisk ?? 0), tone: (s.highRisk ?? 0) > 0 ? 'warn' : 'good', icon: <Gauge className="h-4 w-4" />, hint: `${fmtNumber(s.unhappy ?? 0)} unhappy customer${s.unhappy === 1 ? '' : 's'}`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, breachRisk: state.breachRisk === 'high' ? undefined : 'high' }), scrollTo: true, active: state.breachRisk === 'high' },
                    { label: 'Unassigned', value: fmtNumber(s.unassigned), tone: s.unassigned > 0 ? 'warn' : 'good', icon: <UserX className="h-4 w-4" />, hint: `${fmtNumber(s.major)} major open`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, assignee: assigneeFilter === 'unassigned' ? undefined : 'unassigned' }), scrollTo: true, active: assigneeFilter === 'unassigned' },
                    { label: 'Assigned to me', value: fmtNumber(s.mine), icon: <UserCheck className="h-4 w-4" />, hint: `${fmtNumber(s.dueToday)} due today · ${fmtNumber(s.pendingApprovals)} awaiting approval`, onClick: () => set({ statusCategory: DEFAULTS.statusCategory, assignee: assigneeFilter === 'me' ? undefined : 'me' }), scrollTo: true, active: assigneeFilter === 'me' },
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
        }
      >
        <div className="card overflow-hidden">
          <DataTable
            columns={columns}
            rows={rows}
            loading={list.isLoading || !!legacy}
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
      </ListShell>

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
