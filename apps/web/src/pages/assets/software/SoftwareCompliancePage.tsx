import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, TrendingDown, AlertOctagon, ShieldOff, CalendarClock } from 'lucide-react';
import { COMPLIANCE_POSITIONS, LICENCE_METRICS } from '@itsm/shared';
import { PageHeader, DataTable, Pagination, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, EmptyState, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { COMPLIANCE_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { PositionBadge, UtilisationCell, metricLabel } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, POSITION_LABELS, LICENCE_METRIC_LABELS, titleOf, type CompliancePosition } from '@/components/software/api';

const FILTER_KEYS = ['q', 'customerId', 'productId', 'position', 'metric', 'expiringOnly'];

/** Installed against entitled for every customer and title pair: the live compliance position, never stored. */
export default function SoftwareCompliancePage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState();
  const customers = useCustomersLookup();
  const query = useMemo(() => ({ page, pageSize, q: state.q, customerId: state.customerId, productId: state.productId, position: state.position, metric: state.metric, expiringOnly: state.expiringOnly }), [state, page, pageSize]);
  const list = useQuery({ queryKey: softwareKeys.compliance(query), queryFn: () => softwareApi.compliance(query), placeholderData: (prev) => prev });
  const totals = useQuery({ queryKey: softwareKeys.compliance({ customerId: state.customerId, productId: state.productId, pageSize: 1 }), queryFn: () => softwareApi.compliance({ customerId: state.customerId, productId: state.productId, pageSize: 1 }), staleTime: 60_000 });
  const products = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500, includeInactive: 'true' }), queryFn: () => softwareApi.productsMin({ pageSize: 500, includeInactive: 'true' }), staleTime: 300_000 });
  const customerItems = customers.data?.items ?? [];
  const productItems = products.data?.items ?? [];
  const t = totals.data?.totals;
  const horizon = totals.data?.horizonDays ?? 90;
  const togglePosition = (p: string) => set({ position: state.position === p ? undefined : p });

  const columns: Column<CompliancePosition>[] = [
    { key: 'customer', header: 'Customer', render: (r) => <span className="font-medium">{r.customerName}</span> },
    { key: 'title', header: 'Title', render: (r) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{titleOf(r)}</div>{r.categoryLabel && <div className="text-[11.5px] text-subtle">{r.categoryLabel}</div>}</div> },
    { key: 'metric', header: 'Metric', width: '110px', render: (r) => <span className="text-muted">{metricLabel(r.metric)}</span> },
    { key: 'installed', header: 'Installed', width: '90px', className: 'text-right tabular-nums', render: (r) => <span>{fmtNumber(r.installed)}{r.stale ? <span className="text-amber-600 text-[11px]" title="stale installations still counted"> · {r.stale} stale</span> : null}</span> },
    { key: 'entitled', header: 'Entitled', width: '90px', className: 'text-right tabular-nums', render: (r) => (r.entitled === null ? 'Unlimited' : fmtNumber(r.entitled)) },
    { key: 'unused', header: 'Unused', width: '80px', className: 'text-right tabular-nums', render: (r) => (r.unused === null ? '—' : fmtNumber(r.unused)) },
    { key: 'utilisation', header: 'Utilisation', width: '170px', render: (r) => <UtilisationCell installed={r.installed} entitled={r.entitled} pct={r.utilisationPct} position={r.position} /> },
    { key: 'position', header: 'Position', width: '140px', render: (r) => <PositionBadge position={r.position} /> },
    { key: 'nextEndDate', header: 'Next end', width: '130px', render: (r) => (r.nextEndDate ? <span className="whitespace-nowrap">{fmtDate(r.nextEndDate)}{r.expiringSeats ? <span className="text-amber-600 text-[11px]"> · {fmtNumber(r.expiringSeats)} seats</span> : null}</span> : <span className="text-subtle">—</span>) },
  ];
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.productId) addApplied('productId', `Title: ${(() => { const p = productItems.find((x) => x.id === state.productId); return p ? titleOf(p) : '…'; })()}`);
  if (state.position) addApplied('position', `Position: ${POSITION_LABELS[state.position] ?? state.position}`);
  if (state.metric) addApplied('metric', `Metric: ${LICENCE_METRIC_LABELS[state.metric] ?? state.metric}`);
  if (state.expiringOnly === 'true') addApplied('expiringOnly', `Licence ending within ${horizon} days`);
  const total = list.data?.total;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Licence compliance" subtitle="Installed against entitled per customer and title; a tile narrows the list to that position" />
      <ListShell
        id="software-compliance"
        modules={ASSET_MODULES}
        quick={<SoftwareNav />}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search customer or title…' }}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Title">
              <FilterSelect value={state.productId ?? ''} onChange={(e) => set({ productId: e.target.value })} placeholder="All titles" options={productItems.map((p) => ({ value: p.id, label: titleOf(p) }))} />
            </FilterGroup>
            <FilterGroup label="Position">
              <FilterOptions options={COMPLIANCE_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] ?? p, dot: dotClass(COMPLIANCE_COLORS[p]), count: t ? t[p] : undefined }))} value={state.position} onChange={(v) => set({ position: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Metric">
              <FilterOptions options={LICENCE_METRICS.map((m) => ({ value: m, label: LICENCE_METRIC_LABELS[m] ?? m }))} value={state.metric} onChange={(v) => set({ metric: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Term">
              <FilterToggle label={`Licence ending within ${horizon} days`} checked={state.expiringOnly === 'true'} onChange={(v) => set({ expiringOnly: v ? 'true' : undefined })} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'position' : 'positions'}` : undefined}
        insights={
          <InsightBand
            id="software-compliance"
            loading={totals.isLoading}
            summary={totals.data ? `${fmtNumber(totals.data.total)} customer and title pairs${state.customerId ? ' at this customer' : ''}` : undefined}
            columns={5}
            kpis={
              t
                ? [
                    { label: 'Compliant', value: fmtNumber(t.compliant + t.unlimited), tone: 'good', icon: <ShieldCheck className="h-4 w-4" />, hint: `${fmtNumber(t.unlimited)} on a site licence`, onClick: () => togglePosition('compliant'), active: state.position === 'compliant', scrollTo: true },
                    { label: 'Under-deployed', value: fmtNumber(t.under_deployed), tone: t.under_deployed ? 'warn' : 'good', icon: <TrendingDown className="h-4 w-4" />, hint: 'seats bought but unused', onClick: () => togglePosition('under_deployed'), active: state.position === 'under_deployed', scrollTo: true },
                    { label: 'Over-deployed', value: fmtNumber(t.over_deployed), tone: t.over_deployed ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: 'more installed than licensed', onClick: () => togglePosition('over_deployed'), active: state.position === 'over_deployed', scrollTo: true },
                    { label: 'Unlicensed', value: fmtNumber(t.unlicensed), tone: t.unlicensed ? 'bad' : 'good', icon: <ShieldOff className="h-4 w-4" />, hint: 'installed, no licence in term', onClick: () => togglePosition('unlicensed'), active: state.position === 'unlicensed', scrollTo: true },
                    { label: `Ending · ${horizon}d`, value: fmtNumber(t.expiring), tone: t.expiring ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: 'a licence ends within the notice window', onClick: () => set({ expiringOnly: state.expiringOnly === 'true' ? undefined : 'true' }), active: state.expiringOnly === 'true', scrollTo: true },
                  ]
                : []
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense rowKey={(r) => `${r.customerId}:${r.productId}`} onRowClick={(r) => navigate(`/assets/software/titles/${r.productId}?customerId=${r.customerId}`)} rowClassName={(r) => (r.position === 'over_deployed' || r.position === 'unlicensed' ? 'row-rail-bad' : r.position === 'under_deployed' ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No positions match" description="A position exists for every customer and title with an installation or a licence." />} />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>
    </div>
  );
}
