import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Package, HardDrive, Users, AlertOctagon } from 'lucide-react';
import { LICENCE_MODELS } from '@itsm/shared';
import { PageHeader, Button, DataTable, Pagination, Badge, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, EmptyState, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber } from '@/lib/format';
import { COMPLIANCE_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { ProductForm } from '@/components/software/ProductForm';
import { softwareApi, softwareKeys, LICENCE_MODEL_LABELS, POSITION_LABELS, titleOf, type SoftwareProduct } from '@/components/software/api';

const DEFAULTS = { sort: 'name', order: 'asc' };
const FILTER_KEYS = ['q', 'customerId', 'categoryId', 'licenceModel', 'publisher', 'inUseOnly', 'includeInactive'];

/** The software catalogue: every title we track, with how widely it is installed and licensed. */
export default function SoftwareTitlesPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const customers = useCustomersLookup();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, categoryId: state.categoryId, licenceModel: state.licenceModel, publisher: state.publisher, inUseOnly: state.inUseOnly, includeInactive: state.includeInactive, fields: 'full' }), [state, page, pageSize]);
  const list = useQuery({ queryKey: softwareKeys.products(query), queryFn: () => softwareApi.products(query), placeholderData: (prev) => prev });
  const overview = useQuery({ queryKey: softwareKeys.overview(state.customerId), queryFn: () => softwareApi.overview(state.customerId), staleTime: 60_000 });
  const catalogue = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500, includeInactive: 'true' }), queryFn: () => softwareApi.productsMin({ pageSize: 500, includeInactive: 'true' }), staleTime: 300_000 });
  const publishers = useMemo(() => [...new Set((catalogue.data?.items ?? []).map((p) => p.publisher))].sort((a, b) => a.localeCompare(b)), [catalogue.data]);
  const categories = options('software_category');
  const customerItems = customers.data?.items ?? [];
  const ov = overview.data;
  const overDeployed = ov ? (ov.positions.find((b) => b.key === 'over_deployed')?.count ?? 0) + (ov.positions.find((b) => b.key === 'unlicensed')?.count ?? 0) : 0;

  const columns: Column<SoftwareProduct>[] = [
    { key: 'name', header: 'Title', sortable: true, render: (p) => (
      <div className="leading-tight min-w-0">
        <div className="font-medium flex items-center gap-2"><span className="truncate">{titleOf(p)}</span>{!p.isActive && <Badge color="gray">inactive</Badge>}</div>
        {p.tags.length > 0 && <div className="text-[11.5px] text-subtle truncate">{p.tags.join(' · ')}</div>}
      </div>
    ) },
    { key: 'categoryLabel', header: 'Category', render: (p) => p.categoryLabel ?? <span className="text-subtle">—</span> },
    { key: 'licenceModel', header: 'Licence model', width: '130px', render: (p) => <span className="text-muted">{LICENCE_MODEL_LABELS[p.licenceModel] ?? p.licenceModel}</span> },
    { key: 'installations', header: 'Installations', sortable: true, width: '110px', className: 'text-right tabular-nums', render: (p) => fmtNumber(p.installations) },
    { key: 'customers', header: 'Customers', sortable: true, width: '100px', className: 'text-right tabular-nums', render: (p) => fmtNumber(p.customers) },
    { key: 'licensedSeats', header: 'Licensed seats', width: '120px', className: 'text-right tabular-nums', render: (p) => fmtNumber(p.licensedSeats) },
    { key: 'positions', header: 'Position', render: (p) => {
      const entries = (Object.entries(p.positions) as [string, number][]).filter(([, n]) => n > 0);
      if (!entries.length) return <span className="text-subtle">not in use</span>;
      return <span className="inline-flex flex-wrap gap-1">{entries.map(([k, n]) => <Badge key={k} color={COMPLIANCE_COLORS[k] ?? 'slate'} dot title={POSITION_LABELS[k]}>{n} {POSITION_LABELS[k]?.toLowerCase() ?? k}</Badge>)}</span>;
    } },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.categoryId) addApplied('categoryId', `Category: ${categories.find((c) => c.id === state.categoryId)?.label ?? '…'}`);
  if (state.licenceModel) addApplied('licenceModel', `Model: ${LICENCE_MODEL_LABELS[state.licenceModel] ?? state.licenceModel}`);
  if (state.publisher) addApplied('publisher', `Publisher: ${state.publisher}`);
  if (state.inUseOnly === 'true') addApplied('inUseOnly', 'In use only');
  if (state.includeInactive === 'true') addApplied('includeInactive', 'Including inactive');
  const total = list.data?.total;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Software titles" subtitle="The shared catalogue: publisher, product, version family and how each title is licensed" actions={can('software:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New title</Button>} />
      <ListShell
        id="software-titles"
        modules={ASSET_MODULES}
        quick={<SoftwareNav />}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search publisher or product…' }}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Category">
              <FilterOptions options={categories.map((c) => ({ value: c.id, label: c.label }))} value={state.categoryId} onChange={(v) => set({ categoryId: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Licence model">
              <FilterOptions options={LICENCE_MODELS.map((m) => ({ value: m, label: LICENCE_MODEL_LABELS[m] ?? m }))} value={state.licenceModel} onChange={(v) => set({ licenceModel: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Publisher">
              <FilterSelect value={state.publisher ?? ''} onChange={(e) => set({ publisher: e.target.value })} placeholder="All publishers" options={publishers.map((p) => ({ value: p, label: p }))} />
            </FilterGroup>
            <FilterGroup label="Scope">
              <FilterToggle label="In use only" checked={state.inUseOnly === 'true'} onChange={(v) => set({ inUseOnly: v ? 'true' : undefined })} />
              <FilterToggle label="Include inactive titles" checked={state.includeInactive === 'true'} onChange={(v) => set({ includeInactive: v ? 'true' : undefined })} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'title' : 'titles'}` : undefined}
        insights={
          <InsightBand
            id="software-titles"
            loading={overview.isLoading}
            summary={ov ? `${fmtNumber(ov.titlesInUse)} titles in use${state.customerId ? ' at this customer' : ''}` : undefined}
            kpis={
              ov
                ? [
                    { label: 'Titles in use', value: fmtNumber(ov.titlesInUse), icon: <Package className="h-4 w-4" />, hint: 'with an installation or a licence', onClick: () => set({ inUseOnly: state.inUseOnly === 'true' ? undefined : 'true' }), active: state.inUseOnly === 'true' },
                    { label: 'Installations', value: fmtNumber(ov.installations), icon: <HardDrive className="h-4 w-4" />, hint: `on ${fmtNumber(ov.hosts)} hosts`, to: `/assets/software/installations${state.customerId ? `?customerId=${state.customerId}` : ''}` },
                    { label: 'Licensed seats', value: fmtNumber(ov.seatsLicensed), icon: <Users className="h-4 w-4" />, hint: `${fmtNumber(ov.licencesActive)} licences in term`, to: `/assets/software/licences${state.customerId ? `?customerId=${state.customerId}` : ''}` },
                    { label: 'Over-deployed or unlicensed', value: fmtNumber(overDeployed), tone: overDeployed ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: 'title and customer pairs', to: `/assets/software/compliance?position=over_deployed${state.customerId ? `&customerId=${state.customerId}` : ''}` },
                  ]
                : []
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense onRowClick={(p) => navigate(`/assets/software/titles/${p.id}${state.customerId ? `?customerId=${state.customerId}` : ''}`)} rowClassName={(p) => (p.overDeployedCustomers > 0 ? 'row-rail-bad' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<EmptyState icon={<Package className="h-5 w-5" />} title="No titles match" description="Change or reset the filters, or add a title to the catalogue." action={can('software:manage') ? <Button size="sm" onClick={() => setCreateOpen(true)}>New title</Button> : undefined} />} />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>
      <ProductForm open={createOpen} onClose={() => setCreateOpen(false)} onSaved={(p) => navigate(`/assets/software/titles/${p.id}`)} />
    </div>
  );
}
