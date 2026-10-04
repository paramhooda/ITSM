import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, ShieldCheck, Rocket, Trophy, Settings2 } from 'lucide-react';
import { PageHeader, ListShell, FilterGroup, FilterSelect, FilterOptions, EmptyState, ErrorBlock, LoadingBlock, Button, type AppliedFilter } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { CHANGE_MODULES } from '@/layouts/modules';
import { changesApi, changeKeys, type ChangeTemplate } from '@/components/changes/api';
import { TemplateCard } from '@/components/changes/TemplateCard';
import { TemplateDetailsDrawer } from '@/components/changes/TemplateDetailsDrawer';

const TYPE_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'normal', label: 'Normal' },
  { value: 'emergency', label: 'Emergency' },
];
const APPROVAL_OPTIONS = [{ value: 'true', label: 'Pre-approved only' }];
const FILTER_KEYS = ['q', 'customerId', 'categoryId', 'serviceId', 'type', 'preApproved'];
/** A template name short enough for a stat tile: the part before any bracket, cut at 26 characters. */
const shortName = (name: string) => {
  const head = name.split(' (')[0]!.trim();
  return head.length > 26 ? `${head.slice(0, 25).trimEnd()}…` : head;
};

/**
 * The standard change catalog: the pre-approved, repeatable changes as cards an engineer raises
 * in two clicks. Templates themselves are maintained under Administration → Standard change templates.
 */
export default function ChangeCatalogPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const { options, lookups } = useLookups();
  const customers = useCustomersLookup();
  const customerItems = customers.data?.items ?? [];
  const categories = options('ticket_category');
  const services = lookups?.services ?? [];
  // Only a known type reaches the API: while the router swaps pages the URL may briefly carry another page's `type`.
  const type = TYPE_OPTIONS.some((o) => o.value === state.type) ? state.type : undefined;
  const params = useMemo(
    () => ({ customerId: state.customerId || undefined, q: state.q || undefined, categoryId: state.categoryId || undefined, serviceId: state.serviceId || undefined, changeType: type, preApproved: state.preApproved === 'true' ? true : undefined }),
    [state.customerId, state.q, state.categoryId, state.serviceId, type, state.preApproved],
  );
  const q = useQuery({ queryKey: changeKeys.templates(params), queryFn: () => changesApi.templates(params), placeholderData: (p) => p });
  const [details, setDetails] = useState<ChangeTemplate | null>(null);
  const items = q.data?.items ?? [];
  const canRaise = can('tickets:create');
  const canAdmin = can('admin:config');

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.categoryId) addApplied('categoryId', `Category: ${categories.find((c) => c.id === state.categoryId)?.label ?? '…'}`);
  if (state.serviceId) addApplied('serviceId', `Service: ${services.find((s) => s.id === state.serviceId)?.name ?? '…'}`);
  if (type) addApplied('type', `Type: ${TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type}`);
  if (state.preApproved === 'true') addApplied('preApproved', 'Pre-approved only');

  const preApproved = items.filter((t) => t.skipApproval).length;
  const raised90d = items.reduce((n, t) => n + (t.usage90d ?? 0), 0);
  const top = items.reduce<ChangeTemplate | null>((best, t) => (t.usageCount > (best?.usageCount ?? 0) ? t : best), null);

  const filters = (
    <>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} aria-label="Customer" />
      </FilterGroup>
      <FilterGroup label="Category">
        <FilterSelect value={state.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value })} placeholder="Any category" options={categories.map((c) => ({ value: c.id, label: c.label }))} aria-label="Category" />
      </FilterGroup>
      <FilterGroup label="Service">
        <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={services.map((s) => ({ value: s.id, label: s.name }))} aria-label="Service" />
      </FilterGroup>
      <FilterGroup label="Type">
        <FilterOptions options={TYPE_OPTIONS} value={type} onChange={(v) => set({ type: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Approval">
        <FilterOptions options={APPROVAL_OPTIONS} value={state.preApproved} onChange={(v) => set({ preApproved: v as string | undefined })} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Standard change catalog"
        subtitle="Repeatable, pre-approved changes: pick one and raise it in two clicks"
        actions={canAdmin ? <Button variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/change-templates')}>Manage templates</Button> : undefined}
      />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <ListShell
        id="change-catalog"
        modules={CHANGE_MODULES}
        filters={filters}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Name, key or description…' }}
        applied={applied}
        activeCount={applied.length}
        onClear={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))}
        insights={
          q.data && (
            <KpiGrid
              columns={4}
              items={[
                { label: 'Templates', value: items.length, icon: <LayoutGrid className="h-4 w-4" />, hint: state.customerId ? 'offered to this customer' : 'active, in this view' },
                { label: 'Pre-approved', value: preApproved, tone: preApproved ? 'good' : 'default', icon: <ShieldCheck className="h-4 w-4" />, hint: 'no approval workflow', onClick: () => set({ preApproved: state.preApproved === 'true' ? undefined : 'true' }), active: state.preApproved === 'true', scrollTo: true },
                { label: 'Raised in the last 90 days', value: raised90d, icon: <Rocket className="h-4 w-4" />, hint: 'changes raised from these templates' },
                { label: 'Most used', value: top && top.usageCount ? <span className="text-[17px] leading-tight" title={top.name}>{shortName(top.name)}</span> : '—', icon: <Trophy className="h-4 w-4" />, hint: top && top.usageCount ? `${top.usageCount} time${top.usageCount === 1 ? '' : 's'} all time · open the details` : 'nothing raised yet', onClick: top && top.usageCount ? () => setDetails(top) : undefined },
              ]}
            />
          )
        }
        count={q.data ? `${items.length} template${items.length === 1 ? '' : 's'}` : undefined}
      >
        {q.isLoading ? (
          <LoadingBlock label="Loading the catalog…" />
        ) : items.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<LayoutGrid className="h-5 w-5" />}
              title={applied.length ? 'No template matches these filters' : 'No standard changes yet'}
              description={applied.length ? 'Clear a filter or search for another name.' : 'Templates are maintained under Administration → Standard change templates; a fresh installation ships four.'}
              action={applied.length ? <Button variant="outline" onClick={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))}>Reset filters</Button> : canAdmin ? <Button icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/change-templates')}>Standard change templates</Button> : undefined}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="template-grid">
            {items.map((t) => (
              <TemplateCard key={t.id} t={t} canRaise={canRaise} customerId={state.customerId || undefined} onDetails={() => setDetails(t)} />
            ))}
          </div>
        )}
      </ListShell>
      <TemplateDetailsDrawer template={details} onClose={() => setDetails(null)} canRaise={canRaise} customerId={state.customerId || undefined} />
    </div>
  );
}
