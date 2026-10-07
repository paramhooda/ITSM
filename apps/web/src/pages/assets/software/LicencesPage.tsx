import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileSignature, Users, CalendarClock, ShieldOff, Wallet } from 'lucide-react';
import { LICENCE_STATUSES } from '@itsm/shared';
import { PageHeader, Button, DataTable, Pagination, ListShell, FilterGroup, FilterOptions, FilterSelect, EmptyState, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtMoney, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { LICENCE_STATUS_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
import { useContracts } from '@/components/cmdb/hooks';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { LicenceForm } from '@/components/software/LicenceForm';
import { LicenceStatusBadge, UtilisationCell, TermCell, metricLabel, seats } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, STATUS_LABELS, titleOf, type SoftwareLicence } from '@/components/software/api';

const DEFAULTS = { sort: 'endDate', order: 'asc' };
const FILTER_KEYS = ['q', 'customerId', 'productId', 'contractId', 'status', 'endingWithinDays', 'inTerm'];
const ENDING_OPTIONS = [
  { value: '30', label: 'Ends within 30 days' },
  { value: '90', label: 'Ends within 90 days' },
  { value: '180', label: 'Ends within 180 days' },
  { value: '365', label: 'Ends within a year' },
];

/** Every licence entitlement: seats against installations, the term, the contract and the live status. */
export default function LicencesPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const customers = useCustomersLookup();
  const contracts = useContracts(state.customerId);
  const [createOpen, setCreateOpen] = useState(false);
  const query = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, productId: state.productId, contractId: state.contractId, status: state.status, endingWithinDays: state.endingWithinDays, inTerm: state.inTerm }), [state, page, pageSize]);
  const list = useQuery({ queryKey: softwareKeys.licences(query), queryFn: () => softwareApi.licences(query), placeholderData: (prev) => prev });
  const overview = useQuery({ queryKey: softwareKeys.overview(state.customerId), queryFn: () => softwareApi.overview(state.customerId), staleTime: 60_000 });
  const products = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500, includeInactive: 'true' }), queryFn: () => softwareApi.productsMin({ pageSize: 500, includeInactive: 'true' }), staleTime: 300_000 });
  const customerItems = customers.data?.items ?? [];
  const productItems = products.data?.items ?? [];
  const contractItems = contracts.data ?? [];
  const ov = overview.data;
  const ending90 = ov ? ov.renewals.d30 + ov.renewals.d90 : 0;

  const columns: Column<SoftwareLicence>[] = [
    { key: 'name', header: 'Licence', sortable: true, render: (l) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{l.name}</div><div className="text-[11.5px] text-subtle truncate">{titleOf(l)}</div></div> },
    { key: 'customer', header: 'Customer', sortable: true, render: (l) => l.customerName ?? <span className="text-subtle">—</span> },
    { key: 'metric', header: 'Metric', width: '110px', render: (l) => <span className="text-muted">{metricLabel(l.metric)}</span> },
    { key: 'quantity', header: 'Seats', sortable: true, width: '110px', className: 'text-right tabular-nums', render: (l) => seats(l.metric === 'site' ? null : l.quantity, l.metric) },
    { key: 'installed', header: 'Installed', width: '90px', className: 'text-right tabular-nums', render: (l) => fmtNumber(l.installed) },
    { key: 'utilisation', header: 'Utilisation', width: '160px', render: (l) => <UtilisationCell installed={l.installed} entitled={l.entitled} pct={l.utilisationPct} position={l.position} /> },
    { key: 'endDate', header: 'Term', sortable: true, width: '190px', render: (l) => <TermCell startDate={l.startDate} endDate={l.endDate} daysLeft={l.daysLeft} status={l.status} /> },
    { key: 'renewalDate', header: 'Renewal', sortable: true, width: '110px', render: (l) => (l.renewalDate ? <span className="whitespace-nowrap">{fmtDate(l.renewalDate)}{l.autoRenew ? <span className="text-subtle text-[11px]"> · auto</span> : null}</span> : <span className="text-subtle">—</span>) },
    { key: 'contract', header: 'Contract', width: '120px', render: (l) => (l.contractNumber ? <span className="font-mono text-xs">{l.contractNumber}</span> : <span className="text-subtle">—</span>) },
    { key: 'status', header: 'Status', width: '110px', render: (l) => <LicenceStatusBadge status={l.status} /> },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, ['customerId', 'contractId']);
  if (state.productId) addApplied('productId', `Title: ${(() => { const p = productItems.find((x) => x.id === state.productId); return p ? titleOf(p) : '…'; })()}`);
  if (state.contractId) addApplied('contractId', `Contract: ${contractItems.find((c) => c.id === state.contractId)?.number ?? '…'}`);
  if (state.status) addApplied('status', `Status: ${STATUS_LABELS[state.status] ?? state.status}`);
  if (state.inTerm === 'true') addApplied('inTerm', 'In term today');
  if (state.endingWithinDays) addApplied('endingWithinDays', ENDING_OPTIONS.find((o) => o.value === state.endingWithinDays)?.label ?? `Ends within ${state.endingWithinDays} days`);
  const total = list.data?.total;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Licences" subtitle="Entitlements per customer: seats, term, renewal, contract and how much of each is in use" actions={can('software:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New licence</Button>} />
      <ListShell
        id="software-licences"
        modules={ASSET_MODULES}
        quick={<SoftwareNav />}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search licence or title…' }}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, contractId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Title">
              <FilterSelect value={state.productId ?? ''} onChange={(e) => set({ productId: e.target.value })} placeholder="All titles" options={productItems.map((p) => ({ value: p.id, label: titleOf(p) }))} />
            </FilterGroup>
            <FilterGroup label="Status">
              <FilterOptions options={LICENCE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s, dot: dotClass(LICENCE_STATUS_COLORS[s]) }))} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Contract" hint={state.customerId ? undefined : 'Choose a customer first'}>
              <FilterSelect value={state.contractId ?? ''} disabled={!state.customerId} onChange={(e) => set({ contractId: e.target.value })} placeholder="All contracts" options={contractItems.map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} />
            </FilterGroup>
            <FilterGroup label="Ending within">
              <FilterOptions options={ENDING_OPTIONS} value={state.endingWithinDays} onChange={(v) => set({ endingWithinDays: v as string | undefined })} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'licence' : 'licences'}` : undefined}
        insights={
          <InsightBand
            id="software-licences"
            loading={overview.isLoading}
            summary={ov ? `${fmtNumber(ov.licencesActive)} licences in term${state.customerId ? ' at this customer' : ''}` : undefined}
            columns={5}
            kpis={
              ov
                ? [
                    { label: 'Licences in term', value: fmtNumber(ov.licencesActive), icon: <FileSignature className="h-4 w-4" />, hint: 'active today, expiring and renewed ones included', onClick: () => set({ inTerm: state.inTerm === 'true' ? undefined : 'true', status: undefined, endingWithinDays: undefined }), active: state.inTerm === 'true' },
                    { label: 'Seats licensed', value: fmtNumber(ov.seatsLicensed), icon: <Users className="h-4 w-4" />, hint: 'devices, users and cores in term' },
                    { label: 'Ending · 90d', value: fmtNumber(ending90), tone: ending90 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: `${fmtNumber(ov.renewals.d30)} within 30 days`, onClick: () => set({ endingWithinDays: state.endingWithinDays === '90' ? undefined : '90', status: undefined, inTerm: undefined }), active: state.endingWithinDays === '90' },
                    { label: 'Expired', value: fmtNumber(ov.renewals.expired), tone: ov.renewals.expired ? 'bad' : 'good', icon: <ShieldOff className="h-4 w-4" />, hint: 'past the end date, not renewed', onClick: () => set({ status: state.status === 'expired' ? undefined : 'expired', endingWithinDays: undefined, inTerm: undefined }), active: state.status === 'expired' },
                    { label: 'Spend this year', value: ov.spendYear === null ? '—' : fmtMoney(ov.spendYear), icon: <Wallet className="h-4 w-4" />, hint: 'licences that started this year' },
                  ]
                : []
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense onRowClick={(l) => navigate(`/assets/software/licences/${l.id}`)} rowClassName={(l) => (l.status === 'expired' || l.position === 'over_deployed' ? 'row-rail-bad' : l.status === 'expiring' ? 'row-rail-warn' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<EmptyState icon={<FileSignature className="h-5 w-5" />} title="No licences match" description="Change or reset the filters, or record a licence entitlement." action={can('software:manage') ? <Button size="sm" onClick={() => setCreateOpen(true)}>New licence</Button> : undefined} />} />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>
      <LicenceForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} defaultProductId={state.productId} onSaved={(l) => navigate(`/assets/software/licences/${l.id}`)} />
    </div>
  );
}
