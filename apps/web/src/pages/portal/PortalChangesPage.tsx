import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Activity, CheckCircle2, Clock, Wrench, Layers, User } from 'lucide-react';
import { PageHeader, ListShell, FilterGroup, FilterOptions, FilterSelect, EmptyState, ErrorBlock, LoadingBlock, Badge, type AppliedFilter } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { useListState } from '@/hooks/useListState';
import { PORTAL_STATUS_MODULES } from '@/layouts/modules';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import { PORTAL_CHANGE_STATE_COLORS } from '@/lib/statusColors';
import { portalApi, pk, type PortalChange, type PortalChangesParams } from '@/components/portal/api';

const WHEN_OPTIONS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'past', label: 'Completed' },
  { value: 'all', label: 'Everything' },
];
const STATE_LABEL: Record<string, string> = { planned: 'Planned', approved: 'Approved', in_progress: 'In progress', implemented: 'Implemented', cancelled: 'Cancelled' };
type When = NonNullable<PortalChangesParams['state']>;

/** One planned change, in customer words: when, how long, which services, and the state it is in. */
function PortalChangeCard({ c }: { c: PortalChange }) {
  const end = c.scheduledEnd ? new Date(c.scheduledEnd) : null;
  const sameDay = end && new Date(c.scheduledStart).toDateString() === end.toDateString();
  const when = `${fmtDateTime(c.scheduledStart)}${end ? ` – ${sameDay ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : fmtDateTime(end)}` : ''}`;
  return (
    <Link to={`/portal/tickets/${c.id}`} className="card block px-4 py-3 hover:border-strong hover:shadow-raised transition-[box-shadow,border-color]" data-testid="portal-change">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[12px] text-muted">{c.number}</span>
        <Badge color={PORTAL_CHANGE_STATE_COLORS[c.state] ?? 'slate'} dot>{STATE_LABEL[c.state] ?? c.state}</Badge>
        {c.outcome && <Badge color="red">{c.outcome === 'backed_out' ? 'Backed out' : 'Failed'}</Badge>}
        {c.changeType === 'emergency' && <Badge color="red">Emergency</Badge>}
        {c.isMine && <Badge color="violet"><User className="h-3 w-3" /> Raised by you</Badge>}
      </div>
      <div className="mt-1 font-medium text-[14px] leading-snug">{c.title}</div>
      <div className="mt-1 text-[12.5px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5 shrink-0" /> {when}</span>
        {c.downtimeExpectedMinutes != null && <span className="inline-flex items-center gap-1"><Wrench className="h-3.5 w-3.5 shrink-0" /> {c.downtimeExpectedMinutes ? `Expected downtime ${fmtDuration(c.downtimeExpectedMinutes)}` : 'No downtime expected'}</span>}
        {c.actualStart && c.state !== 'in_progress' && <span>Started {fmtDateTime(c.actualStart)}{c.actualEnd ? `, finished ${fmtDateTime(c.actualEnd)}` : ''}</span>}
      </div>
      {(c.service || c.businessServices.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-subtle shrink-0" />
          {c.service && <Badge color="slate">{c.service.name}</Badge>}
          {c.businessServices.map((b) => <Badge key={b.id} color="indigo">{b.name}</Badge>)}
        </div>
      )}
    </Link>
  );
}

/** The changes we have scheduled on the organisation's services: the window, the state and the expected downtime. */
export default function PortalChangesPage() {
  const { state, set } = useListState({ state: 'upcoming' });
  const when = (WHEN_OPTIONS.some((o) => o.value === state.state) ? state.state : 'upcoming') as When;
  const services = useQuery({ queryKey: pk.services, queryFn: portalApi.services, staleTime: 5 * 60_000 });
  const serviceItems = services.data?.services ?? [];
  const params = useMemo<PortalChangesParams>(() => ({ state: when, serviceId: state.serviceId || undefined }), [when, state.serviceId]);
  const q = useQuery({ queryKey: pk.changes(params), queryFn: () => portalApi.changes(params), placeholderData: (p) => p, refetchInterval: 120_000 });
  const d = q.data;
  const items = d?.items ?? [];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, onRemove: () => void) => applied.push({ key, label, onRemove });
  if (when !== 'upcoming') addApplied('state', `When: ${WHEN_OPTIONS.find((o) => o.value === when)?.label}`, () => set({ state: undefined }));
  if (state.serviceId) addApplied('serviceId', `Service: ${serviceItems.find((s) => s.id === state.serviceId)?.name ?? '…'}`, () => set({ serviceId: undefined }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Planned changes" subtitle="Changes we have scheduled on your services, with their windows and the downtime to expect" />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <ListShell
        id="portal-changes"
        modules={PORTAL_STATUS_MODULES}
        filters={
          <>
            <FilterGroup label="When">
              <FilterOptions options={WHEN_OPTIONS} value={when} onChange={(v) => set({ state: (v as string | undefined) ?? 'upcoming' })} />
            </FilterGroup>
            <FilterGroup label="Service">
              <FilterSelect value={state.serviceId ?? ''} onChange={(e) => set({ serviceId: e.target.value })} placeholder="Any service" options={serviceItems.map((s) => ({ value: s.id, label: s.name }))} aria-label="Service" />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ state: undefined, serviceId: undefined })}
        insights={
          d && (
            <KpiGrid
              columns={3}
              items={[
                { label: 'Upcoming', value: d.counts.upcoming, icon: <CalendarClock className="h-4 w-4" />, hint: `in the next ${Math.round((new Date(d.window.to).getTime() - Date.now()) / 86_400_000)} days`, onClick: () => set({ state: 'upcoming' }), active: when === 'upcoming' },
                { label: 'In progress now', value: d.counts.inProgress, tone: d.counts.inProgress ? 'warn' : 'good', icon: <Activity className="h-4 w-4" />, hint: 'work under way on your services', onClick: () => set({ state: 'in_progress' }), active: when === 'in_progress' },
                { label: 'Completed · 30 days', value: d.counts.past, icon: <CheckCircle2 className="h-4 w-4" />, hint: 'implemented or cancelled', onClick: () => set({ state: 'past' }), active: when === 'past' },
              ]}
            />
          )
        }
        count={d ? `${items.length} change${items.length === 1 ? '' : 's'}${d.preview ? ' · preview' : ''}` : undefined}
      >
        {q.isLoading ? (
          <LoadingBlock label="Looking up the planned changes…" />
        ) : items.length === 0 ? (
          <div className="card">
            <EmptyState icon={<CalendarClock className="h-5 w-5" />} title={when === 'upcoming' && !state.serviceId ? 'Nothing is scheduled on your services' : 'No change matches this view'} description={when === 'upcoming' && !state.serviceId ? 'When we plan work on your services it appears here, with the window and the downtime to expect.' : 'Try another period or service.'} />
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="portal-changes">
            {items.map((c) => <PortalChangeCard key={c.id} c={c} />)}
          </div>
        )}
      </ListShell>
    </div>
  );
}
