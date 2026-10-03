import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, AlertTriangle, Ban, ListChecks } from 'lucide-react';
import { PageHeader, ErrorBlock, EmptyState, ListShell, FilterGroup, FilterSelect, FilterOptions, type AppliedFilter } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { OPERATIONS_MODULES } from '@/layouts/modules';
import { startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';
import { ChangeCalendar, startOfMonth, addMonths, type CalendarView } from '@/components/changes/ChangeCalendar';
import { changesApi, changeKeys } from '@/components/changes/api';

const TYPE_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'normal', label: 'Normal' },
  { value: 'emergency', label: 'Emergency' },
];
const FILTER_KEYS = ['customerId', 'type', 'conflicts'];

/**
 * Every scheduled change on a week or month grid, with the clashes (shared systems, the same
 * business service, blackout windows) marked, and the blackout windows themselves.
 */
export default function ChangeCalendarPage() {
  const navigate = useNavigate();
  const { state, set } = useListState({ view: 'week' });
  const view: CalendarView = state.view === 'month' ? 'month' : 'week';
  const anchor = useMemo(() => (state.day ? new Date(`${state.day}T00:00:00`) : new Date()), [state.day]);
  const range = useMemo(() => {
    if (view === 'week') {
      const ws = startOfWeek(anchor);
      return { from: ws, to: addDays(ws, 7) };
    }
    const first = startOfMonth(anchor);
    return { from: startOfWeek(first), to: addDays(startOfWeek(addMonths(first, 1)), 7) };
  }, [view, anchor]);
  const customers = useCustomersLookup();
  const customerItems = customers.data?.items ?? [];
  const params = useMemo(() => ({ from: range.from.toISOString(), to: range.to.toISOString(), customerId: state.customerId || undefined }), [range, state.customerId]);
  const q = useQuery({ queryKey: changeKeys.calendar(params), queryFn: () => changesApi.calendar(params), placeholderData: (p) => p, refetchInterval: 120_000 });
  const data = q.data;
  const items = useMemo(() => (data?.items ?? []).filter((c) => (!state.type || c.changeType === state.type) && (state.conflicts !== 'true' || c.conflicts.length > 0)), [data, state.type, state.conflicts]);

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.type) addApplied('type', `Type: ${TYPE_OPTIONS.find((t) => t.value === state.type)?.label ?? state.type}`);
  if (state.conflicts === 'true') addApplied('conflicts', 'With conflicts only');

  const filters = (
    <>
      <FilterGroup label="Customer" defaultOpen={!!state.customerId}>
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Type">
        <FilterOptions options={TYPE_OPTIONS} value={state.type} onChange={(v) => set({ type: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Conflicts">
        <FilterOptions options={[{ value: 'true', label: 'With conflicts only' }]} value={state.conflicts} onChange={(v) => set({ conflicts: v as string | undefined })} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Change calendar"
        subtitle="Every scheduled change window, the clashes between them and the blackout windows in force"
        actions={<Segmented value={view} onChange={(v) => set({ view: v === 'month' ? 'month' : undefined })} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />}
      />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <ListShell
        id="change-calendar"
        modules={OPERATIONS_MODULES}
        filters={filters}
        applied={applied}
        activeCount={applied.length}
        onClear={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))}
        insights={
          data && (
            <KpiGrid
              columns={3}
              items={[
                { label: view === 'week' ? 'Changes this week' : 'Changes this month', value: items.length, icon: <CalendarDays className="h-4 w-4" />, hint: `${data.items.filter((c) => c.changeType === 'emergency').length} emergency` },
                { label: 'With conflicts', value: data.items.filter((c) => c.conflicts.length).length, tone: data.counts.conflicts ? 'warn' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'shared systems, same service or a blackout', onClick: () => set({ conflicts: state.conflicts === 'true' ? undefined : 'true' }), active: state.conflicts === 'true' },
                { label: 'Blackout windows', value: data.counts.blackouts, tone: data.counts.blackouts ? 'warn' : 'default', icon: <Ban className="h-4 w-4" />, hint: 'change freezes in the period', to: '/admin/change-blackouts' },
              ]}
            />
          )
        }
        count={data ? `${items.length} change${items.length === 1 ? '' : 's'}` : undefined}
      >
        <ChangeCalendar view={view} anchor={anchor} items={items} blackouts={data?.blackouts ?? []} loading={q.isFetching} onNavigate={(d) => set({ day: ymd(d) })} onSelect={(id) => navigate(`/tickets/${id}?tab=plan`)} />
        {data && data.items.length === 0 && <EmptyState icon={<ListChecks className="h-5 w-5" />} title="No change has a window in this period" description="Set the scheduled start and end on a change's plan tab and it appears here, with any clash marked." />}
      </ListShell>
    </div>
  );
}
