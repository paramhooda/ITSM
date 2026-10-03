import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck, Wrench, Download, CheckCircle2, Star, MapPin, UserRound } from 'lucide-react';
import { PageHeader, Card, Badge, Button, EmptyState, LoadingBlock, ErrorBlock, ListShell, FilterGroup, FilterOptions, type AppliedFilter } from '@/components/ui';
import { PORTAL_MAINTENANCE_MODULES } from '@/layouts/modules';
import { download, ApiError } from '@/api/client';
import { useListState } from '@/hooks/useListState';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel } from '@/components/tickets/Panel';
import { AcknowledgeDialog, type AcknowledgeInput } from '@/components/portal/AcknowledgeDialog';
import { portalApi, pk, type PortalOccurrence, type PortalVisit } from '@/components/portal/api';
import { VISIT_STATUS_COLORS, PM_STATUS_COLORS } from '@/lib/statusColors';

type Entry = { kind: 'visit'; date: string; visit: PortalVisit } | { kind: 'pm'; date: string; occurrence: PortalOccurrence };

const STATUS_COLOR: Record<string, string> = { ...VISIT_STATUS_COLORS, ...PM_STATUS_COLORS };
const FILTER_KEYS = ['kind', 'site'];

function dayLabel(iso: string) {
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return { day: d.toLocaleDateString(undefined, { day: '2-digit' }), month: d.toLocaleDateString(undefined, { month: 'short' }), weekday: d.toLocaleDateString(undefined, { weekday: 'short' }) };
}

function TimelineEntry({ e, highlighted }: { e: Entry; highlighted?: boolean }) {
  const dl = dayLabel(e.date);
  const isVisit = e.kind === 'visit';
  const status = isVisit ? e.visit.status : e.occurrence.status;
  const title = isVisit ? e.visit.title : e.occurrence.programName;
  const site = isVisit ? e.visit.siteName : e.occurrence.siteName;
  const engineer = isVisit ? e.visit.engineerName : e.occurrence.engineerName;
  return (
    <div className={cn('flex gap-3 rounded-lg px-2 py-2', highlighted && 'bg-brand-600/5 ring-1 ring-brand-500/30')}>
      <div className="w-12 shrink-0 text-center">
        <div className="text-[18px] font-semibold leading-none">{dl.day}</div>
        <div className="text-[11px] uppercase text-muted">{dl.month}</div>
        <div className="text-[10.5px] text-subtle">{dl.weekday}</div>
      </div>
      <div className="min-w-0 flex-1 border-l border-default pl-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('h-5 w-5 rounded-md flex items-center justify-center', isVisit ? 'bg-brand-600/10 text-brand-700' : 'bg-emerald-500/10 text-emerald-700')}>{isVisit ? <Wrench className="h-3 w-3" /> : <CalendarCheck className="h-3 w-3" />}</span>
          <span className="font-medium text-[13.5px]">{title}</span>
          <Badge color={STATUS_COLOR[status] ?? 'slate'}>{titleCase(status)}</Badge>
          {isVisit && e.visit.type && <span className="text-[12px] text-muted">{e.visit.type}</span>}
          {!isVisit && <span className="text-[12px] text-muted">Preventive maintenance · {titleCase(e.occurrence.frequency)}</span>}
        </div>
        <div className="mt-1 text-[12.5px] text-muted flex flex-wrap gap-x-3 gap-y-0.5">
          {isVisit && e.visit.scheduledStart && <span>{fmtDateTime(e.visit.scheduledStart)}{e.visit.scheduledEnd ? ` – ${new Date(e.visit.scheduledEnd).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}</span>}
          {!isVisit && e.occurrence.scheduledDate && e.occurrence.scheduledDate !== e.occurrence.plannedDate && <span>Planned {fmtDate(e.occurrence.plannedDate)}</span>}
          {site && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {site}</span>}
          {engineer && <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" /> {engineer}</span>}
          {isVisit && e.visit.ticket?.number && <Link to={`/portal/tickets/${e.visit.ticket.id}`} className="font-mono hover:underline">{e.visit.ticket.number}</Link>}
          {!isVisit && !e.occurrence.requiresSiteVisit && <span>Remote</span>}
        </div>
        {isVisit && e.visit.purpose && <div className="mt-1 text-[12.5px]">{e.visit.purpose}</div>}
      </div>
    </div>
  );
}

function PastVisit({ v, onAcknowledge, highlighted }: { v: PortalVisit; onAcknowledge: (v: PortalVisit) => void; highlighted?: boolean }) {
  async function report() {
    if (!v.reportAttachmentId) return;
    try {
      await download(`/attachments/${v.reportAttachmentId}/download`, v.reportFilename ?? `${v.number}-report.html`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed');
    }
  }
  return (
    <div className={cn('card px-4 py-3', highlighted && 'ring-2 ring-brand-500/30')}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <span className="font-mono text-default">{v.number}</span>
        <Badge color={STATUS_COLOR[v.status] ?? 'slate'}>{titleCase(v.status)}</Badge>
        {v.type && <span>{v.type}</span>}
        <span className="ml-auto" title={fmtDateTime(v.actualEnd ?? v.scheduledStart)}>
          {relativeTime(v.actualEnd ?? v.scheduledStart)}
        </span>
      </div>
      <div className="mt-1 font-medium text-[14px]">{v.title}</div>
      <div className="text-[12.5px] text-muted flex flex-wrap gap-x-3">
        {v.siteName && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {v.siteName}</span>}
        {v.engineerName && <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" /> {v.engineerName}</span>}
        {v.ticket?.number && <Link to={`/portal/tickets/${v.ticket.id}`} className="font-mono hover:underline">{v.ticket.number}</Link>}
      </div>
      {v.workSummary && (
        <div className="mt-2 text-[13px]">
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Work done</div>
          <div className="whitespace-pre-wrap">{v.workSummary}</div>
        </div>
      )}
      {v.recommendations && (
        <div className="mt-2 text-[13px]">
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Recommendations</div>
          <div className="whitespace-pre-wrap">{v.recommendations}</div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {v.acknowledged ? (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> Acknowledged by {v.acknowledgedBy}{v.acknowledgedAt ? ` · ${fmtDate(v.acknowledgedAt)}` : ''}
            {v.rating ? (
              <span className="inline-flex items-center ml-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className={cn('h-3.5 w-3.5', n <= (v.rating ?? 0) ? 'fill-amber-400 text-amber-400' : 'text-subtle')} />
                ))}
              </span>
            ) : null}
          </span>
        ) : v.canAcknowledge ? (
          <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => onAcknowledge(v)}>
            Acknowledge visit
          </Button>
        ) : null}
        {v.reportAttachmentId && (
          <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={report}>
            Visit report
          </Button>
        )}
      </div>
    </div>
  );
}

export type MaintenanceSection = 'upcoming' | 'history';

/** Maintenance & visits: the Upcoming module (what is booked) and the History module (what was done, to review and sign off). */
export default function PortalMaintenancePage({ section = 'upcoming' }: { section?: MaintenanceSection } = {}) {
  const qc = useQueryClient();
  const { state, set } = useListState();
  const highlightVisit = state.visit ?? null;
  const highlightOcc = state.occurrence ?? null;
  const view = useQuery({ queryKey: pk.maintenance, queryFn: portalApi.maintenance, staleTime: 60_000 });
  const [ack, setAck] = useState<PortalVisit | null>(null);
  const acknowledge = useMutation({
    mutationFn: (input: AcknowledgeInput) => portalApi.acknowledge(ack!.id, input),
    onSuccess: () => {
      toast.success('Thank you — the visit is acknowledged');
      setAck(null);
      qc.invalidateQueries({ queryKey: pk.maintenance });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const kind = state.kind === 'visit' || state.kind === 'pm' ? state.kind : undefined;
  const site = state.site || undefined;

  /** Everything the section shows, before the rail's filters, as one list of visits and maintenance. */
  const all = useMemo<(Entry & { siteId: string | null; siteName: string | null })[]>(() => {
    if (!view.data) return [];
    const d = view.data;
    if (section === 'upcoming') {
      const visits = d.upcoming.visits.map((v) => ({ kind: 'visit' as const, date: v.scheduledStart ?? new Date().toISOString(), visit: v, siteId: v.siteId, siteName: v.siteName }));
      const pm = d.upcoming.occurrences.filter((o) => !o.fieldVisitId || !d.upcoming.visits.some((v) => v.id === o.fieldVisitId)).map((o) => ({ kind: 'pm' as const, date: o.date, occurrence: o, siteId: o.siteId, siteName: o.siteName }));
      return [...visits, ...pm].sort((a, b) => a.date.localeCompare(b.date));
    }
    const visits = d.past.visits.map((v) => ({ kind: 'visit' as const, date: v.actualEnd ?? v.scheduledStart ?? '', visit: v, siteId: v.siteId, siteName: v.siteName }));
    const pm = d.past.occurrences.filter((o) => !o.fieldVisitId).map((o) => ({ kind: 'pm' as const, date: o.date, occurrence: o, siteId: o.siteId, siteName: o.siteName }));
    return [...visits, ...pm].sort((a, b) => b.date.localeCompare(a.date));
  }, [view.data, section]);
  const shown = useMemo(() => all.filter((e) => (!kind || e.kind === kind) && (!site || e.siteId === site)), [all, kind, site]);
  const siteOptions = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const e of all) {
      if (!e.siteId) continue;
      const cur = m.get(e.siteId) ?? { label: e.siteName ?? 'Site', count: 0 };
      cur.count++;
      m.set(e.siteId, cur);
    }
    return [...m.entries()].map(([value, v]) => ({ value, label: v.label, count: v.count })).sort((a, b) => a.label.localeCompare(b.label));
  }, [all]);
  const visitCount = all.filter((e) => e.kind === 'visit' && (!site || e.siteId === site)).length;
  const pmCount = all.filter((e) => e.kind === 'pm' && (!site || e.siteId === site)).length;

  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), false);
  const applied: AppliedFilter[] = [];
  if (kind) applied.push({ key: 'kind', label: kind === 'visit' ? 'Engineer visits' : 'Preventive maintenance', onRemove: () => set({ kind: undefined }, false) });
  if (site) applied.push({ key: 'site', label: `Site: ${siteOptions.find((s) => s.value === site)?.label ?? '…'}`, onRemove: () => set({ site: undefined }, false) });

  if (view.isLoading) return <LoadingBlock label="Loading your maintenance schedule…" />;
  if (view.isError) return <ErrorBlock error={view.error} retry={() => view.refetch()} />;

  const windowDays = Math.max(0, Math.round((new Date(view.data!.window.to).getTime() - Date.now()) / 86_400_000));
  const pastVisits = shown.filter((e): e is Entry & { kind: 'visit'; siteId: string | null; siteName: string | null } => e.kind === 'visit');
  const pastPm = shown.filter((e): e is Entry & { kind: 'pm'; siteId: string | null; siteName: string | null } => e.kind === 'pm');
  const noun = section === 'upcoming' ? (shown.length === 1 ? 'booking' : 'bookings') : shown.length === 1 ? 'past entry' : 'past entries';

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={section === 'upcoming' ? 'Upcoming maintenance & visits' : 'Maintenance history'}
        subtitle={section === 'upcoming' ? `Preventive maintenance and engineer visits booked for the next ${windowDays} days.` : 'Past visits to review and sign off, and maintenance already done.'}
      />
      <ListShell
        id={`portal-maintenance-${section}`}
        modules={PORTAL_MAINTENANCE_MODULES}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={`${fmtNumber(shown.length)} ${noun}`}
        filters={
          <>
            <FilterGroup label="Type">
              <FilterOptions options={[{ value: 'visit', label: 'Engineer visits', count: visitCount }, { value: 'pm', label: 'Preventive maintenance', count: pmCount }]} value={kind} onChange={(v) => set({ kind: v as string | undefined }, false)} />
            </FilterGroup>
            {siteOptions.length > 1 && (
              <FilterGroup label="Site">
                <FilterOptions options={siteOptions} value={site} onChange={(v) => set({ site: v as string | undefined }, false)} />
              </FilterGroup>
            )}
          </>
        }
      >
        {section === 'upcoming' ? (
          <Panel title={<span>Upcoming <span className="text-subtle font-normal">next {windowDays} days</span></span>}>
            {shown.length === 0 ? (
              <EmptyState icon={<CalendarCheck className="h-5 w-5" />} title="Nothing scheduled" description={activeCount ? 'Nothing matches these filters.' : 'Planned maintenance and visits will appear here as soon as they are booked.'} />
            ) : (
              <div className="flex flex-col gap-1">
                {shown.map((e) => (
                  <TimelineEntry key={e.kind === 'visit' ? e.visit.id : e.occurrence.id} e={e} highlighted={e.kind === 'visit' ? e.visit.id === highlightVisit : e.occurrence.id === highlightOcc} />
                ))}
              </div>
            )}
          </Panel>
        ) : (
          <div className="flex flex-col gap-4">
            {kind !== 'pm' && (
              <div className="flex flex-col gap-3">
                <div className="text-[13px] font-semibold px-1">Past visits <span className="text-subtle font-normal tnum">{pastVisits.length}</span></div>
                {pastVisits.length === 0 ? (
                  <Card>
                    <EmptyState icon={<Wrench className="h-5 w-5" />} title="No visits yet" description={activeCount ? 'No past visits match these filters.' : 'Completed visits show the work done and let you acknowledge them.'} />
                  </Card>
                ) : (
                  pastVisits.map((e) => <PastVisit key={e.visit.id} v={e.visit} onAcknowledge={setAck} highlighted={e.visit.id === highlightVisit} />)
                )}
              </div>
            )}
            {kind !== 'visit' && (
              <Card title={<span>Past preventive maintenance <span className="text-subtle font-normal tnum">{pastPm.length}</span></span>} padded={false}>
                {pastPm.length === 0 ? (
                  <div className="px-4 py-3 text-[12.5px] text-subtle">{activeCount ? 'No past maintenance matches these filters.' : 'No maintenance has been completed in the last 90 days.'}</div>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {pastPm.map((e) => (
                      <li key={e.occurrence.id} className={cn('px-4 py-2 flex items-center gap-3 text-[12.5px]', e.occurrence.id === highlightOcc && 'bg-brand-600/5')}>
                        <span className="w-24 text-muted shrink-0">{fmtDate(e.occurrence.date)}</span>
                        <span className="flex-1 min-w-0 truncate">{e.occurrence.programName}{e.occurrence.siteName ? ` · ${e.occurrence.siteName}` : ''}</span>
                        <Badge color={STATUS_COLOR[e.occurrence.status] ?? 'slate'}>{titleCase(e.occurrence.status)}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        )}
      </ListShell>
      <AcknowledgeDialog visit={ack} onClose={() => setAck(null)} busy={acknowledge.isPending} onSubmit={(input) => acknowledge.mutateAsync(input)} />
    </div>
  );
}
