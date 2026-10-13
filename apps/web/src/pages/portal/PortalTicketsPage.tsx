import { useEffect, useMemo, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Ticket, Inbox, Reply, Timer, Star } from 'lucide-react';
import { PageHeader, Button, Badge, DataTable, Pagination, EmptyState, ErrorBlock, ListShell, FilterGroup, FilterOptions, FilterDateRange, FilterToggle, type Column, type AppliedFilter } from '@/components/ui';
import { KpiGrid, type KpiItem } from '@/components/dashboards/KpiGrid';
import { KpiSkeleton, Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { PORTAL_LIST_DEFAULTS, PORTAL_RATE_CATEGORIES, PORTAL_TICKET_TYPES, toPortalParams } from '@/components/tickets/listQuery';
import { StatusChips, chipLabel, type PortalStatusChip } from '@/components/portal/StatusChips';
import { TicketCard, TicketSla } from '@/components/portal/TicketCard';
import { portalApi, pk, type PortalTicketRow } from '@/components/portal/api';
import { RatingBadge } from '@/components/surveys/RatingBadge';

/**
 * The organisation's tickets on the staff list's conventions: the URL holds the
 * conditions in the list vocabulary (`statusCategory`, `statusId`, `waitingOn`, `csat`,
 * `priorityId`, `siteId`, `serviceId`, `slaState`, the created and resolved
 * ranges, `type`, `mine`, `q`), one mapping (`toPortalParams`) turns them into
 * the list and stats queries, the breadcrumb reads them back in the order they
 * were applied, and the tiles and chips come from `GET /portal/tickets/stats`,
 * which strips the status keys and the tile keys so a click never moves the
 * other numbers. The status chips are exclusive: each one writes its keys and
 * clears the others.
 */

type Tab = 'all' | (typeof PORTAL_TICKET_TYPES)[number];
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'incident', label: 'Issues' },
  { key: 'request', label: 'Requests' },
  { key: 'problem', label: 'Problems' },
  { key: 'change', label: 'Changes' },
];
const TYPE_NOUN: Record<Tab, string> = { all: 'ticket', incident: 'issue', request: 'request', problem: 'problem', change: 'change' };
const CATEGORY_LABELS: Record<string, string> = { new: 'New', open: 'Open', pending: 'Pending', resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled' };
const SLA_LABELS: Record<string, string> = { breached: 'Breached', at_risk: 'At risk', ok: 'On track' };
/** The page's default view ("All open", the breadcrumb root): the open categories, newest activity first, 25 a page. */
const DEFAULTS = PORTAL_LIST_DEFAULTS;
/** The status keys a chip writes exclusively (`waitingOn` is the Waiting on you chip: what waits on the organisation, a reply or an approval). */
const STATUS_KEYS = ['statusCategory', 'statusId', 'waitingOn', 'csat'];
const FILTER_KEYS = ['q', 'type', ...STATUS_KEYS, 'priorityId', 'siteId', 'serviceId', 'slaState', 'mine', 'createdFrom', 'createdTo', 'resolvedFrom', 'resolvedTo', 'slaOutcome', 'slaEndedFrom', 'slaEndedTo'];
/** The portal's older link keys (the home's "by priority" bars, the assistant, bookmarks): rewritten into the list keys on arrival. */
const LEGACY_KEYS = ['status', 'priority'];
const RATE_CATEGORIES = PORTAL_RATE_CATEGORIES;
const CLOSED_CATEGORIES = 'closed,cancelled';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a chip writes: its own keys, the other status keys cleared (the Open chip is the default view, so it clears them all). */
function chipPatch(chip: PortalStatusChip): Record<string, string | undefined> {
  const clear: Record<string, string | undefined> = { statusCategory: undefined, statusId: undefined, waitingOn: undefined, csat: undefined };
  switch (chip) {
    case 'open': return clear;
    // Waiting on you is one word everywhere: open tickets waiting on the organisation (`waitingOn=customer`, the open categories by default).
    case 'awaiting': return { ...clear, waitingOn: 'customer' };
    case 'resolved': return { ...clear, statusCategory: 'resolved' };
    case 'closed': return { ...clear, statusCategory: CLOSED_CATEGORIES };
    case 'rate': return { ...clear, statusCategory: RATE_CATEGORIES, csat: 'pending' };
    case 'any': return { ...clear, statusCategory: 'any' };
  }
}

/** The chip the URL's status keys stand for, or null when they name a status no chip covers (a link with a status id, two categories, a pending survey inside the open categories, the awaiting-approval door). */
function chipOf(state: Record<string, string>): PortalStatusChip | null {
  // To rate is the pending survey on a resolved or closed ticket: the chip stands only when the categories say so (or no category stands in the way).
  if (state.csat === 'pending') return !state.statusId && !state.waitingOn && (state.statusCategory === RATE_CATEGORIES || state.statusCategory === 'any') ? 'rate' : null;
  if (state.statusId) return null;
  const cat = state.statusCategory;
  // Waiting on you is `waitingOn=customer` on the open categories; with a status narrowing it (the approval door) no chip stands.
  if (state.waitingOn) return state.waitingOn === 'customer' && (!cat || cat === DEFAULTS.statusCategory) ? 'awaiting' : null;
  if (cat === 'any') return 'any';
  if (cat === DEFAULTS.statusCategory) return 'open';
  if (cat === 'resolved') return 'resolved';
  if (cat === CLOSED_CATEGORIES) return 'closed';
  return null;
}

/**
 * Older links carry `status=open|awaiting|resolved|closed|rate|all` and
 * `priority=p1`; they are rewritten once into the list keys so one breadcrumb
 * describes every list (`status=awaiting` becomes `waitingOn=customer`, as
 * `portalStateForLink` reads it). The priority rewrite needs the option ids, so
 * it waits for the lookups ('wait') and the queries stay off until it has run. A
 * link with `csat=pending` and no status key is the To rate door: it gains the
 * rateable categories (as `portalStateForLink` and the portal API do), so the
 * page's default open categories never hide the tickets still to rate.
 */
function legacyPatch(raw: URLSearchParams, lookups: { ready: boolean; priorityIdOf: (key: string) => string | undefined }): Record<string, string | undefined> | 'wait' | null {
  const bareCsat = raw.get('csat') === 'pending' && !raw.has('statusCategory') && !raw.has('statusId');
  const legacy = LEGACY_KEYS.some((k) => raw.has(k));
  if (!legacy && !bareCsat) return null;
  if (!legacy) return { statusCategory: RATE_CATEGORIES };
  if (raw.has('priority') && !lookups.ready) return 'wait';
  const patch: Record<string, string | undefined> = { status: undefined, priority: undefined };
  if (bareCsat) patch.statusCategory = RATE_CATEGORIES;
  const status = raw.get('status');
  if (status && !STATUS_KEYS.some((k) => raw.has(k))) {
    const chip = (status === 'all' ? 'any' : status) as PortalStatusChip;
    if (['open', 'awaiting', 'resolved', 'closed', 'rate', 'any'].includes(chip)) Object.assign(patch, chipPatch(chip));
  }
  const priority = raw.get('priority');
  if (priority && !raw.has('priorityId')) {
    const id = UUID_RE.test(priority) ? priority : lookups.priorityIdOf(priority.toLowerCase());
    if (id) patch.priorityId = id;
  }
  return patch;
}

/** A date-only bound reads as the day; a bound with a time part reads with its time. */
const dateRangeLabel = (from?: string, to?: string) => {
  const timed = (v?: string) => !!v && v.length > 10;
  if (timed(from) || timed(to)) {
    const f = from ? new Date(from) : null;
    const t = to ? new Date(to) : null;
    if (f && t) return `${fmtDateTime(f)} – ${fmtDateTime(t)}`;
    return f ? `from ${fmtDateTime(f)}` : `until ${fmtDateTime(t)}`;
  }
  return from && to ? (from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`) : from ? `from ${fmtDate(from)}` : `until ${fmtDate(to)}`;
};
/** A comma list of ids (a dashboard link with several) reads as its labels joined. */
const labelsOf = (csv: string, lookup: (v: string) => string | undefined) => csv.split(',').filter(Boolean).map((v) => lookup(v) ?? '…').join(', ');
const splitCsv = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined);
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

const EMPTY_TITLES: Record<PortalStatusChip, string> = { open: 'No open tickets', awaiting: 'Nothing is waiting on you', resolved: 'No resolved tickets', closed: 'No closed tickets', rate: 'Nothing to rate', any: 'No tickets' };

export default function PortalTicketsPage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize } = useListState(DEFAULTS);
  // Read-only view of the URL: its key order is the order the conditions were applied, which the breadcrumb follows.
  const [urlParams] = useSearchParams();
  const lookupsQuery = useLookups();
  const { byId, service } = lookupsQuery;
  const lookupsReady = !lookupsQuery.isPending;
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const sites = me.data?.sites ?? [];
  const canServices = me.data?.permissions.includes('portal:contracts') ?? false;
  const services = useQuery({ queryKey: pk.services, queryFn: portalApi.services, enabled: canServices, staleTime: 5 * 60_000 });
  const serviceItems = services.data?.services ?? [];
  const serviceName = (id: string) => serviceItems.find((x) => x.id === id)?.name ?? service(id)?.name;

  /** The configured priorities by id (label, level) for the pill and the breadcrumb; keyed on the lookups payload, which only changes when it is refetched. */
  const priorityOptions = lookupsQuery.data?.options.ticket_priority;
  const priorities = useMemo(() => (priorityOptions ?? []).filter((o) => o.isActive).map((o) => ({ id: o.id, key: o.key.toLowerCase(), label: o.label, level: o.level ?? (Number(o.key.replace(/\D/g, '')) || 5) })).sort((a, b) => a.level - b.level), [priorityOptions]);

  // Older links arrive with the portal's own `status=` and `priority=` keys; normalise them once, then query.
  const legacy = useMemo(() => legacyPatch(urlParams, { ready: lookupsReady, priorityIdOf: (key) => priorities.find((p) => p.key === key)?.id }), [urlParams, lookupsReady, priorities]);
  useEffect(() => {
    if (legacy && legacy !== 'wait') set(legacy, false);
  }, [legacy, set]);

  // A type outside the four the organisation can see reads as All; `toPortalParams` drops it as well, so the route never refuses it.
  const tab: Tab = TABS.some((t) => t.key === state.type) ? (state.type as Tab) : 'all';
  const chip = chipOf(state);
  // One mapping from the URL state to the API (shared with the dashboards guard test), so a link reproduces its number.
  const filterParams = useMemo(() => toPortalParams({ ...state, type: tab }) as Record<string, unknown>, [state, tab]);
  const params = useMemo(() => ({ ...filterParams, page, pageSize, sort: state.sort, order: state.order }), [filterParams, page, pageSize, state.sort, state.order]);
  const list = useQuery({ queryKey: pk.tickets(params), queryFn: () => portalApi.tickets(params), placeholderData: (prev) => prev, refetchInterval: 60_000, enabled: !legacy });
  // The stats take the same filters as the list; the API strips the status keys and the tile keys from the tile aggregates, so one tile never moves another.
  const stats = useQuery({ queryKey: pk.ticketStats(filterParams), queryFn: () => portalApi.ticketStats(filterParams), placeholderData: (prev) => prev, refetchInterval: 60_000, enabled: !legacy });
  const s = stats.data ?? list.data?.counts;
  // The type pills: All always, then a pill for every type the organisation has in the scope (`byType` ignores the type pill, so the set is stable while clicking), plus the pill in effect even at zero so its chip can be read back; All is the sum of the pills.
  const tabs = TABS.filter((t) => t.key === 'all' || t.key === tab || (s ? (s.byType[t.key] ?? 0) > 0 : false));

  const pickChip = (next: PortalStatusChip) => set(chipPatch(next));
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  // The breadcrumb: one chip per condition in effect, in the order they were applied (the URL's key order);
  // removing a chip clears only its key(s), the root chip clears them all.
  const applied: AppliedFilter[] = [];
  const seen = new Set<string>();
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => {
    keys.forEach((k) => seen.add(k));
    applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  };
  const chipFor = (key: string) => {
    switch (key) {
      case 'q': return state.q && addApplied('q', `Search: “${state.q}”`);
      case 'type': return tab !== 'all' && addApplied('type', TABS.find((t) => t.key === tab)?.label ?? tab);
      case 'statusCategory':
      case 'csat':
        // The To rate door carries two keys (the rateable categories, or Any status, with the pending survey); they read as one chip and leave together.
        if (chip === 'rate') return addApplied('rate', chipLabel('rate'), ['statusCategory', 'csat']);
        if (key === 'csat') return state.csat && addApplied('csat', chipLabel('rate'));
        if (chip === 'any' || chip === 'resolved' || chip === 'closed') return addApplied('statusCategory', chipLabel(chip));
        return state.statusCategory && state.statusCategory !== DEFAULTS.statusCategory && addApplied('statusCategory', `Status: ${labelsOf(state.statusCategory, (c) => CATEGORY_LABELS[c])}`);
      // The Waiting on you chip (one word with the home tile and the brief); any other party is refused by the portal route, so it never reads back.
      case 'waitingOn': return state.waitingOn && addApplied('waitingOn', state.waitingOn === 'customer' ? chipLabel('awaiting') : `Waiting on: ${state.waitingOn}`);
      case 'statusId': return state.statusId && addApplied('statusId', `Status: ${labelsOf(state.statusId, (id) => byId(id)?.label)}`);
      case 'priorityId': return state.priorityId && addApplied('priorityId', `Priority: ${labelsOf(state.priorityId, (id) => priorities.find((p) => p.id === id)?.label)}`);
      case 'siteId': return state.siteId && addApplied('siteId', `Site: ${sites.find((x) => x.id === state.siteId)?.name ?? '…'}`);
      case 'serviceId': return state.serviceId && addApplied('serviceId', `Service: ${serviceName(state.serviceId) ?? '…'}`);
      case 'slaState': return state.slaState && addApplied('slaState', `SLA: ${labelsOf(state.slaState, (v) => SLA_LABELS[v] ?? v)}`);
      case 'mine': return state.mine === 'true' && addApplied('mine', 'Raised by me');
      case 'createdFrom':
      case 'createdTo': return (state.createdFrom || state.createdTo) && addApplied('created', `Created: ${dateRangeLabel(state.createdFrom, state.createdTo)}`, ['createdFrom', 'createdTo']);
      case 'resolvedFrom':
      case 'resolvedTo': return (state.resolvedFrom || state.resolvedTo) && addApplied('resolved', `Resolved: ${dateRangeLabel(state.resolvedFrom, state.resolvedTo)}`, ['resolvedFrom', 'resolvedTo']);
      case 'slaOutcome':
      case 'slaEndedFrom':
      case 'slaEndedTo': return state.slaOutcome && addApplied('slaOutcome', `Resolution SLA ${state.slaOutcome === 'met' ? 'met' : 'breached'}: ${dateRangeLabel(state.slaEndedFrom, state.slaEndedTo)}`, ['slaOutcome', 'slaEndedFrom', 'slaEndedTo']);
      default: return undefined;
    }
  };
  for (const k of urlParams.keys()) if (!seen.has(k) && FILTER_KEYS.includes(k)) chipFor(k);

  // "1–25 of 148 open tickets": what the list holds, named the way the breadcrumb reads.
  const total = list.data?.total;
  const noun = plural(total ?? 0, TYPE_NOUN[tab]);
  const before = chip === 'open' ? 'open ' : chip === 'resolved' ? 'resolved ' : chip === 'closed' ? 'closed ' : '';
  const after = chip === 'awaiting' ? ' waiting on you' : chip === 'rate' ? ' to rate' : '';
  const countLine = total === undefined ? undefined : total === 0 ? `0 ${before}${noun}${after}` : `${fmtNumber((page - 1) * pageSize + 1)}–${fmtNumber(Math.min(total, page * pageSize))} of ${fmtNumber(total)} ${before}${noun}${after}`;

  // The four tiles: Open is the baseline every other number is a slice of; the others toggle one condition in place.
  const windowOpened = s ? s.series.reduce((n, d) => n + d.opened, 0) : 0;
  const windowResolved = s ? s.series.reduce((n, d) => n + d.resolved, 0) : 0;
  // The series follows the created range only when both bounds are set and span 90 days or less (the API's rule); otherwise it is the last 14 days.
  const spanDays = state.createdFrom && state.createdTo ? Math.round((Date.parse(state.createdTo.slice(0, 10)) - Date.parse(state.createdFrom.slice(0, 10))) / 86_400_000) : NaN;
  const windowLabel = spanDays >= 0 && spanDays <= 90 ? 'in the range' : 'in 14 days';
  const tiles: KpiItem[] = s
    ? [
        { label: 'Open tickets', value: fmtNumber(s.open), icon: <Inbox className="h-4 w-4" />, hint: `${fmtNumber(windowOpened)} opened · ${fmtNumber(windowResolved)} resolved ${windowLabel}`, spark: s.series.map((d) => d.opened), sparkLabel: 'Tickets opened per day' },
        { label: 'Waiting on you', value: fmtNumber(s.awaiting), tone: s.awaiting > 0 ? 'warn' : 'default', icon: <Reply className="h-4 w-4" />, hint: s.awaiting > 0 ? 'a reply or an approval the service desk needs from you' : 'nothing waiting on you', onClick: () => pickChip(chip === 'awaiting' ? 'open' : 'awaiting'), active: chip === 'awaiting' },
        { label: 'Breached', value: fmtNumber(s.breached), tone: s.breached > 0 ? 'bad' : 'default', icon: <Timer className="h-4 w-4" />, hint: `${fmtNumber(s.atRisk)} at risk`, onClick: () => set({ slaState: state.slaState === 'breached' ? undefined : 'breached' }), active: state.slaState === 'breached' },
        { label: 'To rate', value: fmtNumber(s.toRate), tone: s.toRate > 0 ? 'accent' : 'default', icon: <Star className="h-4 w-4" />, hint: s.toRate > 0 ? 'resolved tickets waiting for your rating' : 'every resolved ticket is rated', onClick: () => pickChip(chip === 'rate' ? 'open' : 'rate'), active: chip === 'rate' },
      ]
    : [];

  const columns: Column<PortalTicketRow>[] = [
    { key: 'number', header: 'Ticket', width: '130px', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
    { key: 'title', header: 'Summary', render: (r) => (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-[460px]">{r.title}</div>
        <div className="text-[11.5px] text-muted flex items-center gap-1.5">
          <TypeBadge type={r.type} short className="px-1 py-0 text-[10px]" />
          {r.requesterName && <span>{r.isMine ? 'Raised by you' : `Raised by ${r.requesterName}`}</span>}
          {r.assigneeName && <span>· Engineer: {r.assigneeName}</span>}
          {r.surveyPending && <Badge color="amber">Rate</Badge>}
          {r.csatRating != null && <RatingBadge rating={r.csatRating} />}
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
  // The empty state names the status word the breadcrumb reads; the untouched default view invites a new ticket.
  const pristine = chip === 'open' && applied.length === 0;
  const empty = (
    <EmptyState
      icon={<Ticket className="h-5 w-5" />}
      title={chip ? EMPTY_TITLES[chip] : 'No tickets here'}
      description={pristine ? 'Everything is in hand. Raise a ticket if something needs our attention.' : chip === 'rate' && applied.length === 1 ? 'Resolved tickets waiting for your rating appear here; you can also rate from the email we send when a ticket is resolved.' : 'Try another filter, or Reset to return to the open tickets.'}
      action={pristine ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Raise a ticket</Button> : undefined}
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
        activeCount={applied.length}
        onClear={clearFilters}
        applied={applied}
        breadcrumbRoot="All open"
        clearLabel="Reset"
        count={countLine}
        quick={
          <>
            <Segmented
              size="sm"
              // "All" is every ticket type of the organisation counted over the same scope; every type it holds has a pill, so All is the sum of the pills.
              options={tabs.map((t) => ({ value: t.key, label: t.label, count: s ? (t.key === 'all' ? s.allTypes : s.byType[t.key] ?? 0) : undefined }))}
              value={tab}
              onChange={(v) => set({ type: v === 'all' ? undefined : v })}
            />
            {/* The status chips take a row of their own, so the group never splits mid-way when the row wraps. */}
            <span className="basis-full h-0" aria-hidden />
            <StatusChips value={chip} onChange={pickChip} counts={s ? { open: s.open, awaiting: s.awaiting, resolved: s.resolved, closed: s.closed, rate: s.toRate, any: s.all } : undefined} />
          </>
        }
        insights={
          <section aria-label="Insights">
            {s ? <KpiGrid items={tiles} columns={4} /> : <KpiSkeleton count={4} />}
          </section>
        }
        filters={
          <>
            {sites.length > 1 && (
              <FilterGroup label="Site">
                <FilterOptions options={sites.map((x) => ({ value: x.id, label: x.name }))} value={state.siteId} onChange={(v) => set({ siteId: v as string | undefined })} />
              </FilterGroup>
            )}
            <FilterGroup label="Priority">
              <FilterOptions options={priorities.map((p) => ({ value: p.id, label: p.label, dot: dotClass(PRIORITY_LEVEL_COLORS[p.level] ?? 'slate') }))} value={splitCsv(state.priorityId)} onChange={(v) => set({ priorityId: Array.isArray(v) ? v.join(',') : v })} />
            </FilterGroup>
            {serviceItems.length > 0 && (
              <FilterGroup label="Service">
                <FilterOptions options={serviceItems.map((x) => ({ value: x.id, label: x.name }))} value={state.serviceId} onChange={(v) => set({ serviceId: v as string | undefined })} />
              </FilterGroup>
            )}
            <FilterGroup label="Raised by">
              <FilterToggle label="Raised by me" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined })} />
            </FilterGroup>
            <FilterGroup label="Created">
              <FilterDateRange from={state.createdFrom} to={state.createdTo} onChange={(r) => set({ createdFrom: r.from, createdTo: r.to })} />
            </FilterGroup>
            <FilterGroup label="Resolved">
              <FilterDateRange from={state.resolvedFrom} to={state.resolvedTo} onChange={(r) => set({ resolvedFrom: r.from, resolvedTo: r.to })} />
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
              {!list.isLoading && !legacy && items.length === 0 && <div className="card">{empty}</div>}
            </div>
            <div className="hidden md:block card">
              <DataTable columns={columns} rows={items} loading={list.isLoading || !!legacy} empty={empty} onRowClick={(r) => navigate(`/portal/tickets/${r.id}`)} />
              <Pagination page={page} pageSize={list.data?.pageSize ?? pageSize} total={list.data?.total ?? 0} onPage={(p) => set({ page: p }, false)} />
            </div>
            <div className="md:hidden">
              <Pagination page={page} pageSize={list.data?.pageSize ?? pageSize} total={list.data?.total ?? 0} onPage={(p) => set({ page: p }, false)} />
            </div>
          </>
        )}
      </ListShell>
    </div>
  );
}
