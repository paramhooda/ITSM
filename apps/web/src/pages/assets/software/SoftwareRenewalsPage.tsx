import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { PageHeader, DataTable, ListShell, FilterGroup, FilterOptions, FilterSelect, EmptyState, type AppliedFilter, type Column } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { LICENCE_STATUS_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { LicenceStatusBadge, metricLabel, seats } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, daysLeftClass, daysLeftText, titleOf, type SoftwareLicence } from '@/components/software/api';

const WINDOWS = [30, 90, 180, 365] as const;
const STATUS_OPTIONS = [
  { value: 'expiring', label: 'Ending or renewing', dot: dotClass(LICENCE_STATUS_COLORS.expiring) },
  { value: 'expired', label: 'Already expired', dot: dotClass(LICENCE_STATUS_COLORS.expired) },
];

/** Licences ending or renewing within the window, expired first; renewed licences never appear. */
export default function SoftwareRenewalsPage() {
  const navigate = useNavigate();
  const { state, set } = useListState({ days: '90' });
  const customers = useCustomersLookup();
  const days = WINDOWS.includes(Number(state.days) as (typeof WINDOWS)[number]) ? Number(state.days) : 90;
  const query = useMemo(() => ({ days, customerId: state.customerId, status: state.status ?? 'all', limit: 500 }), [days, state.customerId, state.status]);
  const q = useQuery({ queryKey: softwareKeys.renewals(query), queryFn: () => softwareApi.renewals(query), placeholderData: (prev) => prev });
  const customerItems = customers.data?.items ?? [];
  const items = q.data?.items ?? [];

  const columns: Column<SoftwareLicence>[] = [
    { key: 'name', header: 'Licence', render: (l) => <span className="font-medium">{l.name}</span> },
    { key: 'customer', header: 'Customer', render: (l) => l.customerName ?? <span className="text-subtle">—</span> },
    { key: 'title', header: 'Title', render: (l) => <span className="text-muted">{titleOf(l)}</span> },
    { key: 'seats', header: 'Seats', width: '110px', className: 'text-right tabular-nums', render: (l) => <span title={metricLabel(l.metric)}>{seats(l.metric === 'site' ? null : l.quantity, l.metric)}</span> },
    { key: 'installed', header: 'Installed', width: '90px', className: 'text-right tabular-nums', render: (l) => fmtNumber(l.installed) },
    { key: 'endDate', header: 'Ends', width: '110px', render: (l) => (l.endDate ? fmtDate(l.endDate) : <span className="text-subtle">—</span>) },
    { key: 'renewalDate', header: 'Renewal date', width: '120px', render: (l) => (l.renewalDate ? fmtDate(l.renewalDate) : <span className="text-subtle">—</span>) },
    { key: 'autoRenew', header: 'Auto-renew', width: '100px', render: (l) => (l.autoRenew ? 'Yes' : <span className="text-subtle">No</span>) },
    { key: 'contract', header: 'Contract', width: '120px', render: (l) => (l.contractNumber ? <span className="font-mono text-xs">{l.contractNumber}</span> : <span className="text-subtle">—</span>) },
    { key: 'daysLeft', header: 'Days left', width: '140px', render: (l) => <div className="flex flex-col items-start gap-1 whitespace-nowrap"><span className={daysLeftClass(l.daysLeft)}>{daysLeftText(l.daysLeft, l.endDate) || '—'}</span><LicenceStatusBadge status={l.status} /></div> },
  ];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.status) addApplied('status', STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Licence renewals" subtitle="What ends or renews within the window, expired first" />
      <ListShell
        id="software-renewals"
        modules={ASSET_MODULES}
        quick={
          <div className="flex items-center gap-3 flex-wrap">
            <SoftwareNav />
            <Segmented size="sm" options={WINDOWS.map((d) => ({ value: String(d), label: d === 365 ? '1 year' : `${d} days` }))} value={String(days)} onChange={(v) => set({ days: v })} />
          </div>
        }
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Status">
              <FilterOptions options={STATUS_OPTIONS} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ customerId: undefined, status: undefined })}
        count={q.data ? `${fmtNumber(items.length)} ${items.length === 1 ? 'licence' : 'licences'} · ${fmtNumber(q.data.expired)} expired` : undefined}
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(l) => navigate(`/assets/software/licences/${l.id}`)} rowClassName={(l) => (l.status === 'expired' ? 'row-rail-bad' : l.daysLeft !== null && l.daysLeft <= 30 ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<CalendarClock className="h-5 w-5" />} title={`Nothing ends or renews within ${days === 365 ? 'a year' : `${days} days`}`} description="Widen the window, or look at the licences list for the full estate." />} />
        </div>
      </ListShell>
    </div>
  );
}
