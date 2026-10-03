import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle, FileSignature, CalendarClock, Gauge, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, DataTable, Pagination, Drawer, Card, EmptyState, FilterChip, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { ExpiringContracts, type ExpiringContract } from '@/components/dashboards/ExpiringContracts';
import { get, post, ApiError } from '@/api/client';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtNumber } from '@/lib/format';
import { cn, dotClass } from '@/lib/utils';
import { CONTRACT_STATUS_COLORS } from '@/lib/statusColors';
import { CONTRACT_MODULES } from '@/layouts/modules';
import { ContractForm, type ContractPayload } from '@/components/contracts/ContractForm';
import { ContractStatusBadge, ExpiryCountdown } from '@/components/contracts/ContractBits';
import { CONTRACT_STATUSES, type ContractListItem, type ContractDetail, type Paginated } from '@/components/contracts/types';

interface ContractSummary {
  total: number;
  active: number;
  expiring30: number;
  expiring90: number;
  expired: number;
  byStatus: { key: string; label: string; count: number }[];
  byType: { key: string; label: string; count: number }[];
  entitlementsOverThreshold: number;
  entitlementsExhausted: number;
}

const DEFAULTS = { sort: 'endDate', order: 'asc' };
const FILTER_KEYS = ['q', 'customerId', 'status', 'typeId', 'expiringWithinDays', 'serviceId', 'ownerUserId'];
const EXPIRY_OPTIONS = [
  { value: '30', label: 'Within 30 days' },
  { value: '60', label: 'Within 60 days' },
  { value: '90', label: 'Within 90 days' },
];

export default function ContractListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options, byKey, lookups } = useLookups();
  const customers = useCustomersLookup();
  const engineers = useEngineers();
  const [creating, setCreating] = useState(state.new === '1');
  const statuses = (state.status ?? '').split(',').filter(Boolean);

  const query = useQuery({
    queryKey: ['contracts', 'list', state],
    queryFn: () => get<Paginated<ContractListItem>>('/contracts', { page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, status: state.status, typeId: state.typeId, expiringWithinDays: state.expiringWithinDays, serviceId: state.serviceId, ownerUserId: state.ownerUserId }),
    placeholderData: (prev) => prev,
  });
  const summaryParams = useMemo(() => ({ customerId: state.customerId || undefined }), [state.customerId]);
  const summary = useQuery({ queryKey: ['contracts', 'summary', summaryParams], queryFn: () => get<ContractSummary>('/contracts/summary', summaryParams), placeholderData: (prev) => prev, staleTime: 30_000 });
  const expiring = useQuery({ queryKey: ['contracts', 'expiring', summaryParams], queryFn: () => get<{ items: ExpiringContract[]; total: number }>('/contracts/expiring', { days: 90, ...summaryParams }), staleTime: 30_000 });

  const create = useMutation({
    mutationFn: (body: ContractPayload) => post<ContractDetail>('/contracts', body),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      toast.success(`Contract ${c.number} created`);
      setCreating(false);
      navigate(`/contracts/${c.id}`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  const toggleStatus = (s: string) => set({ status: (statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s]).join(',') });
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const columns: Column<ContractListItem>[] = [
    { key: 'number', header: 'Number', sortable: true, width: '140px', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
    { key: 'name', header: 'Contract', sortable: true, render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.name}</div>{r.ownerName && <div className="text-[11px] text-subtle">Owner: {r.ownerName}</div>}</div> },
    { key: 'customer', header: 'Customer', sortable: true, render: (r) => <span>{r.customerName} <span className="text-subtle font-mono text-[11px]">{r.customerCode}</span></span> },
    { key: 'typeLabel', header: 'Type', render: (r) => <span className="text-muted">{r.typeLabel ?? '—'}</span> },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <ContractStatusBadge status={r.status} label={r.statusLabel} color={r.statusColor} /> },
    { key: 'startDate', header: 'Start', sortable: true, render: (r) => <span className="text-muted">{fmtDate(r.startDate)}</span> },
    { key: 'endDate', header: 'End', sortable: true, render: (r) => <ExpiryCountdown days={r.daysToExpiry} endDate={r.endDate} status={r.status} /> },
    { key: 'services', header: 'Services', render: (r) => <span className="text-muted truncate block max-w-[260px]" title={r.serviceNames.join(', ')}>{r.serviceNames.length ? r.serviceNames.join(', ') : '—'}</span> },
    {
      key: 'entitlements',
      header: 'Entitlements',
      render: (r) =>
        r.entitlements.count === 0 ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {r.entitlements.count}
            {(r.entitlements.anyExhausted || r.entitlements.anyOverThreshold) && <AlertTriangle className={cn('h-3.5 w-3.5', r.entitlements.anyExhausted ? 'text-red-500' : 'text-amber-500')} aria-label={r.entitlements.anyExhausted ? 'Entitlement exhausted' : 'Entitlement over threshold'} />}
          </span>
        ),
    },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' });
  const sm = summary.data;
  const statusLabel = (s: string) => byKey('contract_status', s)?.label ?? sm?.byStatus.find((b) => b.key === s)?.label ?? s;
  const statusColor = (s: string) => byKey('contract_status', s)?.color ?? CONTRACT_STATUS_COLORS[s] ?? 'slate';
  const customerItems = customers.data?.items ?? [];
  const types = options('contract_type');
  const services = lookups?.services ?? [];
  const owners = engineers.data ?? [];
  const countByType = new Map((sm?.byType ?? []).map((b) => [b.key, b.count]));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (statuses.length) addApplied('status', `Status: ${statuses.map(statusLabel).join(', ')}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.typeId) addApplied('typeId', `Type: ${types.find((o) => o.id === state.typeId)?.label ?? '…'}`);
  if (state.expiringWithinDays) addApplied('expiringWithinDays', `Expiring: ${EXPIRY_OPTIONS.find((o) => o.value === state.expiringWithinDays)?.label.toLowerCase() ?? `within ${state.expiringWithinDays} days`}`);
  if (state.serviceId) addApplied('serviceId', `Service: ${services.find((sv) => sv.id === state.serviceId)?.name ?? '…'}`);
  if (state.ownerUserId) addApplied('ownerUserId', `Owner: ${owners.find((u) => u.id === state.ownerUserId)?.name ?? '…'}`);
  const total = query.data?.total;

  const rail = (
    <>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Type">
        <FilterOptions options={types.map((o) => ({ value: o.id, label: o.label, count: sm ? countByType.get(o.key) ?? 0 : undefined }))} value={state.typeId} onChange={(v) => set({ typeId: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Expiring" hint="Covering contracts ending soon">
        <FilterOptions options={EXPIRY_OPTIONS} value={state.expiringWithinDays} onChange={(v) => set({ expiringWithinDays: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Service" defaultOpen={!!state.serviceId}>
        <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((sv) => ({ value: sv.id, label: sv.name }))} />
      </FilterGroup>
      <FilterGroup label="Owner" defaultOpen={!!state.ownerUserId}>
        <FilterSelect value={state.ownerUserId ?? ''} onChange={(e) => set({ ownerUserId: e.target.value })} placeholder="Any owner" options={owners.map((u) => ({ value: u.id, label: u.name }))} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Contracts & Scope"
        subtitle={sm ? `${fmtNumber(sm.active)} active contracts · ${fmtNumber(sm.expiring90)} ending within 90 days` : 'Coverage, SLA policy, entitlements and scope per customer'}
        actions={can('contracts:manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New contract</Button>}
      />

      <ListShell
        id="contracts"
        modules={CONTRACT_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search number or name…' }}
        filters={rail}
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'contract' : 'contracts'}` : undefined}
        quick={CONTRACT_STATUSES.map((s) => (
          <FilterChip key={s} active={statuses.includes(s)} onClick={() => toggleStatus(s)} dot={dotClass(statusColor(s))} count={sm?.byStatus.find((b) => b.key === s)?.count ?? 0}>
            {statusLabel(s)}
          </FilterChip>
        ))}
        insights={
          <InsightBand
            id="contracts"
            loading={summary.isLoading}
            summary={sm ? `${fmtNumber(sm.total)} contracts${state.customerId ? ' for this customer' : ''}` : undefined}
            kpis={
              sm
                ? [
                    { label: 'Active contracts', value: fmtNumber(sm.active), icon: <FileSignature className="h-4 w-4" />, hint: `${fmtNumber(sm.total)} in total · ${fmtNumber(sm.expired)} expired`, onClick: () => set({ status: 'active,expiring' }), scrollTo: true, active: state.status === 'active,expiring' },
                    { label: 'Expiring · 90d', value: fmtNumber(sm.expiring90), tone: sm.expiring90 > 0 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: `${fmtNumber(sm.expiring30)} within 30 days`, onClick: () => set({ expiringWithinDays: state.expiringWithinDays === '90' ? undefined : '90' }), scrollTo: true, active: state.expiringWithinDays === '90' },
                    { label: 'Entitlements near limit', value: fmtNumber(sm.entitlementsOverThreshold), tone: sm.entitlementsOverThreshold > 0 ? 'warn' : 'good', icon: <Gauge className="h-4 w-4" />, hint: 'usage past the warning threshold' },
                    { label: 'Entitlements exhausted', value: fmtNumber(sm.entitlementsExhausted), tone: sm.entitlementsExhausted > 0 ? 'bad' : 'good', icon: <Ban className="h-4 w-4" />, hint: 'further usage is out of scope' },
                  ]
                : []
            }
            panels={
              sm && (
                <>
                  <Panel title="Expiring soon" subtitle="Contracts ending within 90 days">
                    <ExpiringContracts items={(expiring.data?.items ?? []).slice(0, 6)} />
                  </Panel>
                  <Panel title="By status" subtitle="Click a status to filter">
                    <BreakdownBar dense items={sm.byStatus.map((b) => ({ label: statusLabel(b.key), value: b.count, color: statusColor(b.key), active: statuses.length === 1 && statuses[0] === b.key }))} onSelect={(i) => { const b = sm.byStatus.find((x) => statusLabel(x.key) === i.label); if (b) set({ status: statuses.length === 1 && statuses[0] === b.key ? '' : b.key }); }} />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        <Card padded={false}>
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            loading={query.isLoading}
            onRowClick={(r) => navigate(`/contracts/${r.id}`)}
            sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }}
            onSort={onSort}
            rowClassName={(r) => (r.entitlements.anyExhausted || (r.daysToExpiry < 0 && !['terminated', 'renewed', 'draft'].includes(r.status)) ? 'row-rail-bad' : r.entitlements.anyOverThreshold || (r.daysToExpiry >= 0 && r.daysToExpiry <= 30 && !['terminated', 'renewed', 'draft'].includes(r.status)) ? 'row-rail-warn' : undefined)}
            empty={<EmptyState icon={<FileSignature className="h-5 w-5" />} title="No contracts" description="Contracts define covered services and sites, SLA policy, entitlements and scope." />}
          />
          <Pagination page={page} pageSize={pageSize} total={query.data?.total ?? 0} onPage={setPage} />
        </Card>
      </ListShell>
      <Drawer open={creating} onClose={() => { setCreating(false); if (state.new) set({ new: undefined }, false); }} title="New contract" width="max-w-3xl">
        {creating && <ContractForm mode="create" customerId={state.customerId || undefined} onSubmit={(b) => create.mutate(b)} onCancel={() => setCreating(false)} submitting={create.isPending} />}
      </Drawer>
    </div>
  );
}
