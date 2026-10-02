import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, ListShell, FilterGroup, FilterOptions, FilterSelect, DataTable, Pagination, Badge, ProgressBar, ErrorBlock, type Column, type AppliedFilter } from '@/components/ui';
import { CONTRACT_MODULES } from '@/layouts/modules';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PERIOD_LABELS } from '@/components/contracts/ContractBits';
import { overviewApi, ovKeys, type EntitlementRow } from '@/components/overview/api';

const STATUS_OPTIONS = [
  { value: 'ok', label: 'Within limits', dot: 'bg-emerald-500' },
  { value: 'over_threshold', label: 'Over threshold', dot: 'bg-amber-500' },
  { value: 'exhausted', label: 'Exhausted', dot: 'bg-red-500' },
];
const FILTER_KEYS = ['customerId', 'status'];
const DEFAULTS = { sort: 'pct', order: 'desc' };

const tone = (e: EntitlementRow) => (e.exhausted ? 'bad' : e.overThreshold ? 'warn' : 'good');

/** Entitlements module: every active entitlement across contracts, with consumption against its limit. */
export default function EntitlementsPage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const customers = useCustomersLookup();
  const params = useMemo(() => ({ page, pageSize, q: state.q || undefined, customerId: state.customerId || undefined, status: state.status || undefined, sort: state.sort, order: state.order as 'asc' | 'desc' }), [page, pageSize, state.q, state.customerId, state.status, state.sort, state.order]);
  const list = useQuery({ queryKey: ovKeys.entitlements(params), queryFn: () => overviewApi.entitlements(params), placeholderData: (p) => p });
  const customerName = (id?: string) => customers.data?.items.find((c) => c.id === id)?.name ?? 'Customer';

  const columns: Column<EntitlementRow>[] = [
    { key: 'customer', header: 'Customer', sortable: true, render: (r) => <span className="font-medium">{r.customerName}</span> },
    { key: 'contract', header: 'Contract', width: '130px', render: (r) => <span className="font-mono text-[12.5px]">{r.contractNumber}</span> },
    { key: 'name', header: 'Entitlement', sortable: true, render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.name}</div>{r.type && <div className="text-[11px] text-subtle">{r.type}</div>}</div> },
    { key: 'period', header: 'Period', render: (r) => <div className="text-[12.5px] leading-tight"><div>{PERIOD_LABELS[r.period] ?? r.period}</div>{r.periodStart && r.periodEnd && <div className="text-[11px] text-subtle whitespace-nowrap">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</div>}</div> },
    { key: 'quantity', header: 'Quantity', className: 'text-right tabular-nums whitespace-nowrap', render: (r) => <>{fmtNumber(r.quantity, 2)} <span className="text-subtle">{r.unit}</span></> },
    { key: 'used', header: 'Used', sortable: true, className: 'text-right tabular-nums', render: (r) => fmtNumber(r.used, 2) },
    { key: 'remaining', header: 'Remaining', className: 'text-right tabular-nums', render: (r) => <span className={cn(r.remaining <= 0 && 'text-red-600 font-medium')}>{fmtNumber(r.remaining, 2)}</span> },
    {
      key: 'pct',
      header: 'Utilisation',
      sortable: true,
      width: '160px',
      render: (r) => (
        <div className="min-w-[120px]">
          <div className={cn('text-[12px] tabular-nums text-right', { good: 'text-muted', warn: 'text-amber-600', bad: 'text-red-600' }[tone(r)])}>{fmtNumber(r.pct, 0)}%</div>
          <ProgressBar pct={r.pct} tone={tone(r)} className="mt-0.5" />
        </div>
      ),
    },
    { key: 'flags', header: '', width: '130px', render: (r) => (r.exhausted ? <Badge color="red" dot>Exhausted</Badge> : r.overThreshold ? <Badge color="amber" dot>Over threshold</Badge> : <span className="text-subtle">—</span>) },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' });

  const applied: AppliedFilter[] = [];
  if (state.customerId) applied.push({ key: 'customerId', label: customerName(state.customerId), onRemove: () => set({ customerId: undefined }) });
  if (state.status) applied.push({ key: 'status', label: STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status, onRemove: () => set({ status: undefined }) });
  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const total = list.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Entitlements" subtitle="Consumption against every contract entitlement" />
      <ListShell
        id="entitlements"
        modules={CONTRACT_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search entitlement or contract…' }}
        activeCount={activeCount}
        onClear={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))}
        applied={applied}
        count={list.data ? `${fmtNumber(total)} ${total === 1 ? 'entitlement' : 'entitlements'}` : undefined}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Status">
              <FilterOptions options={STATUS_OPTIONS} value={state.status} onChange={(v) => set({ status: typeof v === 'string' ? v : undefined })} />
            </FilterGroup>
          </>
        }
      >
        <div className="card overflow-hidden">
          {list.isError ? (
            <ErrorBlock error={list.error} retry={() => list.refetch()} />
          ) : (
            <>
              <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense onRowClick={(r) => navigate(`/contracts/${r.contractId}?tab=entitlements`)} rowClassName={(r) => (r.exhausted ? 'row-rail-bad' : r.overThreshold ? 'row-rail-warn' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<div className="text-[13px] text-subtle py-8 text-center">{activeCount || state.q ? 'No entitlements match these filters' : 'No entitlements yet'}</div>} />
              <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
            </>
          )}
        </div>
      </ListShell>
    </div>
  );
}
