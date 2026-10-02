import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CalendarDays, List as ListIcon } from 'lucide-react';
import { PageHeader, Button, ListShell, FilterGroup, FilterSelect, FilterToggle, type AppliedFilter } from '@/components/ui';
import { FIELD_MODULES } from '@/layouts/modules';
import { Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber } from '@/lib/format';
import { itemsOf } from '@/components/tickets/api';
import { fieldApi, fieldKeys } from '@/components/field/api';
import { VisitForm } from '@/components/field/VisitForm';
import { VisitCalendar, startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';

const FILTER_KEYS = ['customerId', 'engineerId', 'teamId', 'mine', 'cancelled'];

/** Calendar module of Field Service: one week, one row per engineer, filtered from the rail. */
export default function FieldCalendarPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set } = useListState();
  const { lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const me = useAuthStore((s) => s.user);
  const [createOpen, setCreateOpen] = useState(false);

  const weekStart = useMemo(() => (state.week ? startOfWeek(new Date(state.week + 'T00:00:00')) : startOfWeek(new Date())), [state.week]);
  const calParams = useMemo(
    () => ({ from: ymd(weekStart), to: ymd(addDays(weekStart, 7)), engineerId: state.mine === 'true' ? undefined : state.engineerId || undefined, teamId: state.teamId || undefined, customerId: state.customerId || undefined, includeCancelled: state.cancelled === 'true' ? 'true' : undefined }),
    [weekStart, state.engineerId, state.teamId, state.customerId, state.mine, state.cancelled],
  );
  const calendar = useQuery({ queryKey: fieldKeys.calendar(calParams), queryFn: () => fieldApi.calendar(calParams), placeholderData: (prev) => prev });
  const items = useMemo(() => (calendar.data?.items ?? []).filter((v) => state.mine !== 'true' || v.engineerId === me?.id || v.additionalEngineerIds.includes(me?.id ?? '')), [calendar.data, state.mine, me?.id]);

  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const teams = lookups?.teams ?? [];
  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), false);
  const applied: AppliedFilter[] = [];
  if (state.customerId) applied.push({ key: 'customerId', label: `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, onRemove: () => set({ customerId: undefined }, false) });
  if (state.engineerId) applied.push({ key: 'engineerId', label: `Engineer: ${engineers.data?.find((u) => u.id === state.engineerId)?.name ?? '…'}`, onRemove: () => set({ engineerId: undefined }, false) });
  if (state.teamId) applied.push({ key: 'teamId', label: `Team: ${teams.find((t) => t.id === state.teamId)?.name ?? '…'}`, onRemove: () => set({ teamId: undefined }, false) });
  if (state.mine === 'true') applied.push({ key: 'mine', label: 'My visits', onRemove: () => set({ mine: undefined }, false) });
  if (state.cancelled === 'true') applied.push({ key: 'cancelled', label: 'Including cancelled', onRemove: () => set({ cancelled: undefined }, false) });

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Calendar"
        subtitle={calendar.data ? `${weekLabel} · ${fmtNumber(items.length)} ${items.length === 1 ? 'visit' : 'visits'}` : 'Visits by engineer and day'}
        actions={can('field:manage') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New visit</Button> : undefined}
      />
      <ListShell
        id="field-calendar"
        modules={FIELD_MODULES}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={calendar.data ? `${fmtNumber(items.length)} ${items.length === 1 ? 'visit' : 'visits'} this week` : undefined}
        toolbar={<Segmented size="sm" options={[{ value: 'list', label: <span className="inline-flex items-center gap-1.5"><ListIcon className="h-3.5 w-3.5" />List</span> }, { value: 'calendar', label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Calendar</span> }]} value="calendar" onChange={(v) => v === 'list' && navigate('/field/visits')} />}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Engineer">
              <FilterSelect value={state.engineerId ?? ''} onChange={(e) => set({ engineerId: e.target.value, mine: undefined }, false)} placeholder="Any engineer" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
              <FilterSelect value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value }, false)} placeholder="Any team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
              <FilterToggle label="My visits" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined, engineerId: undefined }, false)} />
            </FilterGroup>
            <FilterGroup label="Show">
              <FilterToggle label="Include cancelled" checked={state.cancelled === 'true'} onChange={(v) => set({ cancelled: v ? 'true' : undefined }, false)} />
            </FilterGroup>
          </>
        }
      >
        <VisitCalendar weekStart={weekStart} items={items} loading={calendar.isFetching} onWeekChange={(d) => set({ week: ymd(d) }, false)} onSelect={(id) => navigate(`/field/${id}`)} />
        {calendar.isError && <div className="text-[12.5px] text-red-600">{(calendar.error as Error).message}</div>}
      </ListShell>

      <VisitForm
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultCustomerId={state.customerId}
        onSaved={(v) => {
          setCreateOpen(false);
          qc.invalidateQueries({ queryKey: fieldKeys.all });
          navigate(`/field/${v.id}`);
        }}
      />
    </div>
  );
}
