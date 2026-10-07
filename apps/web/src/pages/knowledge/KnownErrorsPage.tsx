import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bug, Wrench, Globe, Link2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { PageHeader, Select, Pagination, EmptyState, LoadingBlock, ErrorBlock, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, DataTable, type AppliedFilter, type Column } from '@/components/ui';
import { KNOWLEDGE_MODULES, PORTAL_KNOWLEDGE_MODULES } from '@/layouts/modules';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { dotClass, truncate } from '@/lib/utils';
import { KNOWN_ERROR_STATUS_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { portalApi, pk } from '@/components/portal/api';
import { kedbApi, kedbKeys, type KnownErrorRow, type PortalKnownError } from '@/components/known-errors/api';
import { KeStatusBadge } from '@/components/known-errors/KeStatusBadge';

const DEFAULTS = { status: 'active', pageSize: '25' };
const FILTER_KEYS = ['q', 'status', 'customerId', 'serviceId', 'portalVisible', 'hasFixChange'];
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'open', label: 'Open' },
  { value: 'fix_in_progress', label: 'Fix in progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All' },
];
const PORTAL_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];
const SORT_OPTIONS = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'identifiedAt:desc', label: 'Recently identified' },
  { value: 'incidents:desc', label: 'Most linked incidents' },
  { value: 'publishedAt:desc', label: 'Recently published' },
  { value: 'title:asc', label: 'Title A–Z' },
  { value: 'number:asc', label: 'Number' },
];
const firstLine = (s: string | null | undefined, n = 120) => (s ? truncate(s.split('\n').find((l) => l.trim()) ?? '', n) : '');

/** Known errors module of Knowledge: the known error database for staff, the published known issues for customers. */
export default function KnownErrorsPage() {
  const isCustomer = useAuthStore((s) => s.isCustomer());
  return isCustomer ? <PortalKnownErrors /> : <StaffKnownErrors />;
}

function StaffKnownErrors() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { lookups } = useLookups();
  const customers = useCustomersLookup();
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const services = lookups?.services ?? [];

  const query = useMemo(
    () => ({
      page,
      pageSize,
      q: state.q || undefined,
      status: state.status || 'active',
      customerId: state.customerId || undefined,
      serviceId: state.serviceId || undefined,
      portalVisible: state.portalVisible === 'true' ? 'true' : undefined,
      hasFixChange: state.hasFixChange === 'true' ? 'true' : undefined,
      sort: state.sort || undefined,
      order: state.order || undefined,
    }),
    [page, pageSize, state],
  );
  const list = useQuery({ queryKey: kedbKeys.list(query), queryFn: () => kedbApi.list(query), placeholderData: (prev) => prev });
  const stats = useQuery({ queryKey: kedbKeys.stats(state.customerId || null), queryFn: () => kedbApi.stats(state.customerId || null), staleTime: 60_000, placeholderData: (prev) => prev });
  const s = stats.data;

  const isDefault = (k: string) => k === 'status' && (state.status ?? 'active') === 'active';
  const activeCount = FILTER_KEYS.filter((k) => state[k] && !isDefault(k)).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const toggleStatus = (v: string) => set({ status: state.status === v ? undefined : v });

  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.status && state.status !== 'active') applied.push({ key: 'status', label: `Status: ${STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status}`, onRemove: () => set({ status: undefined }) });
  if (state.customerId) applied.push({ key: 'customerId', label: `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, onRemove: () => set({ customerId: undefined }) });
  if (state.serviceId) applied.push({ key: 'serviceId', label: `Service: ${services.find((sv) => sv.id === state.serviceId)?.name ?? '…'}`, onRemove: () => set({ serviceId: undefined }) });
  if (state.portalVisible === 'true') applied.push({ key: 'portalVisible', label: 'Published to portal', onRemove: () => set({ portalVisible: undefined }) });
  if (state.hasFixChange === 'true') applied.push({ key: 'hasFixChange', label: 'Has a fix change', onRemove: () => set({ hasFixChange: undefined }) });

  const statusCount = (v: string) => (s ? (v === 'active' ? s.open + s.fixInProgress : v === 'open' ? s.open : v === 'fix_in_progress' ? s.fixInProgress : v === 'resolved' ? s.resolved : v === 'retired' ? s.retired : s.total) : null);
  const filters = (
    <>
      <FilterGroup label="Status" hint="Active = open or with a fix in progress">
        <FilterOptions options={STATUS_OPTIONS.map((o) => ({ ...o, dot: o.value === 'active' || o.value === 'all' ? null : dotClass(KNOWN_ERROR_STATUS_COLORS[o.value]), count: statusCount(o.value) }))} value={state.status ?? 'active'} onChange={(v) => set({ status: (v as string | undefined) || undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="Any customer" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Service">
        <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
      </FilterGroup>
      <FilterGroup label="Portal" hint="Entries with customer wording published to the portal">
        <FilterToggle label="Published to portal" checked={state.portalVisible === 'true'} onChange={(v) => set({ portalVisible: v ? 'true' : undefined })} />
      </FilterGroup>
      <FilterGroup label="Fix" hint="Known errors whose permanent fix is a change ticket">
        <FilterToggle label="Has a fix change" checked={state.hasFixChange === 'true'} onChange={(v) => set({ hasFixChange: v ? 'true' : undefined })} />
      </FilterGroup>
    </>
  );

  const columns: Column<KnownErrorRow>[] = [
    { key: 'number', header: 'Number', width: '112px', render: (r) => <span className="font-mono text-[12px] text-secondary whitespace-nowrap">{r.number}</span> },
    {
      key: 'title',
      header: 'Title',
      render: (r) => (
        <div className="min-w-[220px] max-w-[400px]">
          <div className="truncate font-medium text-[13.5px]">{r.title}</div>
          <div className="text-[11.5px] text-muted truncate">{firstLine(r.workaround) || <span className="text-subtle">No workaround documented</span>}</div>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (r) => (
        <div className="min-w-[140px] max-w-[200px]">
          <div className="truncate">{r.customerName}</div>
          <div className="text-[11.5px] text-muted truncate">{r.serviceName ?? <span className="text-subtle">No service</span>}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <KeStatusBadge status={r.keStatus} /> },
    {
      key: 'fixChange',
      header: 'Fix change',
      render: (r) =>
        r.fixChange ? (
          <Link to={`/tickets/${r.fixChange.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12px] text-brand-700 hover:underline whitespace-nowrap" title={r.fixChange.title}>
            {r.fixChange.number}
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
    { key: 'incidents', header: 'Incidents', className: 'text-right', render: (r) => <span className="tnum">{fmtNumber(r.incidents)}</span> },
    { key: 'published', header: 'Published', render: (r) => (r.portalVisible ? <span className="whitespace-nowrap inline-flex items-center gap-1 text-emerald-700"><Globe className="h-3 w-3" /> {r.publishedAt ? fmtDate(r.publishedAt) : 'Yes'}</span> : <span className="text-subtle">—</span>) },
    // The least load-bearing column (the default sort already orders by it): shown on wide screens only so the table fits without a scrollbar.
    { key: 'updated', header: 'Updated', className: 'hidden 2xl:table-cell', render: (r) => <span className="text-muted whitespace-nowrap" title={fmtDateTime(r.updatedAt)}>{relativeTime(r.updatedAt)}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Known errors" subtitle="Problems with a documented workaround, their fix and the incidents they explain" />
      <ListShell
        id="known-errors"
        modules={KNOWLEDGE_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search titles, symptoms, workarounds…' }}
        filters={filters}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} known ${list.data.total === 1 ? 'error' : 'errors'}` : undefined}
        toolbar={
          <Select
            className="w-48 h-8 py-0 text-[13px]"
            value={state.sort ? `${state.sort}:${state.order ?? 'desc'}` : ''}
            onChange={(e) => {
              const [sort, order] = e.target.value.split(':');
              set({ sort: sort || undefined, order: order || undefined });
            }}
            placeholder={state.q ? 'Sort: relevance' : 'Sort: recently updated'}
            options={SORT_OPTIONS}
          />
        }
        insights={
          <InsightBand
            id="known-errors"
            loading={stats.isLoading}
            summary={s ? `${fmtNumber(s.total)} known ${s.total === 1 ? 'error' : 'errors'}${state.customerId ? ' for this customer' : ''}` : undefined}
            kpis={
              s
                ? [
                    { label: 'Open known errors', value: fmtNumber(s.open), tone: s.open > 0 ? 'warn' : 'good', icon: <Bug className="h-4 w-4" />, hint: 'workaround known, no fix under way', onClick: () => toggleStatus('open'), active: state.status === 'open' },
                    { label: 'Fix in progress', value: fmtNumber(s.fixInProgress), icon: <Wrench className="h-4 w-4" />, hint: 'a permanent fix is being delivered', onClick: () => toggleStatus('fix_in_progress'), active: state.status === 'fix_in_progress' },
                    { label: 'Published to portal', value: fmtNumber(s.published), tone: 'accent', icon: <Globe className="h-4 w-4" />, hint: 'customers can read the workaround', onClick: () => set({ portalVisible: state.portalVisible === 'true' ? undefined : 'true' }), active: state.portalVisible === 'true' },
                    { label: 'Incidents linked · 30d', value: fmtNumber(s.incidentsLinked30d), icon: <Link2 className="h-4 w-4" />, hint: 'incidents explained by a known error' },
                  ]
                : []
            }
            panels={
              s && (
                <>
                  <Panel title="By service" subtitle="Where the known errors sit">
                    <BreakdownBar
                      dense
                      emptyText="No known errors yet"
                      items={s.byService.map((b) => ({ label: b.name, value: b.count, active: !!b.id && state.serviceId === b.id }))}
                      onSelect={(i) => {
                        const b = s.byService.find((x) => x.name === i.label);
                        if (b?.id) set({ serviceId: state.serviceId === b.id ? undefined : b.id });
                      }}
                    />
                  </Panel>
                  <Panel title="Most linked" subtitle="Known errors that explain the most incidents">
                    <RowList dense empty="No incidents linked yet" items={s.mostLinked.map((k) => ({ key: k.id, leading: <Bug className="h-3.5 w-3.5 text-subtle" />, primary: k.title, secondary: k.number, right: `${fmtNumber(k.incidents)} incident${k.incidents === 1 ? '' : 's'}`, href: `/knowledge/known-errors/${k.id}` }))} />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        <div className="card overflow-hidden">
          {list.isLoading && <LoadingBlock />}
          {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
          {list.data && list.data.items.length === 0 && (
            <EmptyState icon={<Bug className="h-5 w-5" />} title="No known errors match" description={activeCount > 0 || state.q ? 'Adjust the filters or the search term.' : 'Flag a problem as a known error on its Problem analysis tab once a workaround is documented.'} />
          )}
          {list.data && list.data.items.length > 0 && (
            <>
              <DataTable columns={columns} rows={list.data.items} dense onRowClick={(r) => navigate(`/knowledge/known-errors/${r.id}`)} />
              <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
            </>
          )}
        </div>
      </ListShell>
    </div>
  );
}

function PortalKnownErrors() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const query = useMemo(() => ({ page, pageSize, q: state.q || undefined, status: state.status || 'active', serviceId: state.serviceId || undefined }), [page, pageSize, state]);
  const list = useQuery({ queryKey: pk.knownErrors(query), queryFn: () => portalApi.knownErrors(query), placeholderData: (prev) => prev });
  const services = list.data?.services ?? [];
  const activeCount = ['q', 'serviceId'].filter((k) => state[k]).length + (state.status && state.status !== 'active' ? 1 : 0);
  const clear = () => set({ q: undefined, status: undefined, serviceId: undefined });
  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.status && state.status !== 'active') applied.push({ key: 'status', label: `Status: ${PORTAL_STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status}`, onRemove: () => set({ status: undefined }) });
  if (state.serviceId) applied.push({ key: 'serviceId', label: `Service: ${services.find((sv) => sv.id === state.serviceId)?.name ?? '…'}`, onRemove: () => set({ serviceId: undefined }) });

  const columns: Column<PortalKnownError>[] = [
    {
      key: 'title',
      header: 'Known issue',
      render: (r) => (
        <div className="min-w-[220px] max-w-[560px]">
          <div className="truncate font-medium text-[13.5px]">{r.title}</div>
          <div className="text-[12px] text-muted line-clamp-2 whitespace-normal">{r.summary ?? ''}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <KeStatusBadge status={r.keStatus} portal /> },
    { key: 'service', header: 'Service', render: (r) => r.service?.name ?? <span className="text-subtle">—</span> },
    { key: 'published', header: 'Published', render: (r) => <span className="whitespace-nowrap">{r.publishedAt ? fmtDate(r.publishedAt) : '—'}</span> },
    { key: 'updated', header: 'Updated', render: (r) => <span className="text-muted whitespace-nowrap" title={fmtDateTime(r.updatedAt)}>{relativeTime(r.updatedAt)}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Known issues" subtitle="Problems we know about, with what to do in the meantime" />
      <ListShell
        id="portal-known-errors"
        modules={PORTAL_KNOWLEDGE_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search known issues…' }}
        filters={
          <>
            <FilterGroup label="Status">
              <FilterOptions options={PORTAL_STATUS_OPTIONS.map((o) => ({ ...o, dot: o.value === 'resolved' ? dotClass(KNOWN_ERROR_STATUS_COLORS.resolved) : null }))} value={state.status ?? 'active'} onChange={(v) => set({ status: (v as string | undefined) || undefined })} />
            </FilterGroup>
            <FilterGroup label="Service">
              <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
            </FilterGroup>
          </>
        }
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} known ${list.data.total === 1 ? 'issue' : 'issues'}` : undefined}
      >
        <div className="card overflow-hidden">
          {list.isLoading && <LoadingBlock />}
          {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
          {list.data && list.data.items.length === 0 && (
            <EmptyState icon={<Bug className="h-5 w-5" />} title="No known issues right now" description={activeCount > 0 ? 'Try a different search term or filter.' : 'Nothing is published for your organisation at the moment.'} />
          )}
          {list.data && list.data.items.length > 0 && (
            <>
              <DataTable columns={columns} rows={list.data.items} dense onRowClick={(r) => navigate(`/knowledge/known-errors/${r.id}`)} />
              <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
            </>
          )}
        </div>
      </ListShell>
    </div>
  );
}

