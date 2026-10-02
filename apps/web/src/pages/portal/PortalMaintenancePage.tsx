import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck, Wrench, Download, CheckCircle2, Star, MapPin, UserRound } from 'lucide-react';
import { PageHeader, Card, Badge, Button, EmptyState, LoadingBlock, ErrorBlock } from '@/components/ui';
import { download, ApiError } from '@/api/client';
import { fmtDate, fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel } from '@/components/tickets/Panel';
import { AcknowledgeDialog, type AcknowledgeInput } from '@/components/portal/AcknowledgeDialog';
import { portalApi, pk, type PortalOccurrence, type PortalVisit } from '@/components/portal/api';

type Entry = { kind: 'visit'; date: string; visit: PortalVisit } | { kind: 'pm'; date: string; occurrence: PortalOccurrence };

const STATUS_COLOR: Record<string, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'indigo', completed: 'green', cancelled: 'gray', planned: 'slate', missed: 'red', rescheduled: 'amber' };

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
          <span className={cn('h-5 w-5 rounded-md flex items-center justify-center', isVisit ? 'bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>{isVisit ? <Wrench className="h-3 w-3" /> : <CalendarCheck className="h-3 w-3" />}</span>
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
      await download(`/attachments/${v.reportAttachmentId}/download`, v.reportFilename ?? `${v.number}-report.pdf`);
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
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-emerald-700 dark:text-emerald-300">
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

export default function PortalMaintenancePage() {
  const qc = useQueryClient();
  const [search] = useSearchParams();
  const highlightVisit = search.get('visit');
  const highlightOcc = search.get('occurrence');
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

  const upcoming = useMemo<Entry[]>(() => {
    if (!view.data) return [];
    const entries: Entry[] = [
      ...view.data.upcoming.visits.map((v): Entry => ({ kind: 'visit', date: v.scheduledStart ?? new Date().toISOString(), visit: v })),
      ...view.data.upcoming.occurrences.filter((o) => !o.fieldVisitId || !view.data!.upcoming.visits.some((v) => v.id === o.fieldVisitId)).map((o): Entry => ({ kind: 'pm', date: o.date, occurrence: o })),
    ];
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }, [view.data]);
  const pastPm = view.data?.past.occurrences.filter((o) => !o.fieldVisitId) ?? [];

  if (view.isLoading) return <LoadingBlock label="Loading your maintenance schedule…" />;
  if (view.isError) return <ErrorBlock error={view.error} retry={() => view.refetch()} />;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Maintenance & visits" subtitle="Planned preventive maintenance and engineer visits to your sites, plus past visits to review and sign off." />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
        <Panel title={<span>Upcoming <span className="text-subtle font-normal">next {Math.round((new Date(view.data!.window.to).getTime() - Date.now()) / 86_400_000)} days</span></span>}>
          {upcoming.length === 0 ? (
            <EmptyState icon={<CalendarCheck className="h-5 w-5" />} title="Nothing scheduled" description="Planned maintenance and visits will appear here as soon as they are booked." />
          ) : (
            <div className="flex flex-col gap-1">
              {upcoming.map((e) => (
                <TimelineEntry key={e.kind === 'visit' ? e.visit.id : e.occurrence.id} e={e} highlighted={e.kind === 'visit' ? e.visit.id === highlightVisit : e.occurrence.id === highlightOcc} />
              ))}
            </div>
          )}
        </Panel>
        <div className="flex flex-col gap-3">
          <div className="text-[13px] font-semibold px-1">Past visits</div>
          {(view.data?.past.visits.length ?? 0) === 0 ? (
            <Card>
              <EmptyState icon={<Wrench className="h-5 w-5" />} title="No visits yet" description="Completed visits show the work done and let you acknowledge them." />
            </Card>
          ) : (
            view.data!.past.visits.map((v) => <PastVisit key={v.id} v={v} onAcknowledge={setAck} highlighted={v.id === highlightVisit} />)
          )}
          {pastPm.length > 0 && (
            <Card title="Past preventive maintenance" padded={false}>
              <ul className="divide-y divide-[var(--border)]">
                {pastPm.map((o) => (
                  <li key={o.id} className={cn('px-4 py-2 flex items-center gap-3 text-[12.5px]', o.id === highlightOcc && 'bg-brand-600/5')}>
                    <span className="w-24 text-muted shrink-0">{fmtDate(o.date)}</span>
                    <span className="flex-1 min-w-0 truncate">{o.programName}{o.siteName ? ` · ${o.siteName}` : ''}</span>
                    <Badge color={STATUS_COLOR[o.status] ?? 'slate'}>{titleCase(o.status)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      <AcknowledgeDialog visit={ack} onClose={() => setAck(null)} busy={acknowledge.isPending} onSubmit={(input) => acknowledge.mutateAsync(input)} />
    </div>
  );
}
