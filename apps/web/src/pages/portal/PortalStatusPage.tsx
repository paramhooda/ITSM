import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, CalendarCheck, Wrench, Siren, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { PageHeader, Badge, EmptyState, LoadingBlock, ErrorBlock } from '@/components/ui';
import { Panel } from '@/components/tickets/Panel';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SERVICE_HEALTH_COLORS } from '@/lib/statusColors';
import { announcementsApi, type ServiceHealth, type StatusService, type MaintenanceItem } from '@/components/announcements/api';
import { AnnouncementCard } from '@/components/announcements/AnnouncementStrip';

export const HEALTH_LABEL: Record<ServiceHealth, string> = { good: 'Operational', degraded: 'Degraded', maintenance: 'Under maintenance', down: 'Major incident' };
const HEALTH_ICON: Record<ServiceHealth, typeof CheckCircle2> = { good: CheckCircle2, degraded: AlertTriangle, maintenance: Wrench, down: Siren };
const HEALTH_TONE: Record<ServiceHealth, string> = { good: 'bg-emerald-500', degraded: 'bg-amber-500', maintenance: 'bg-blue-500', down: 'bg-red-600' };

/** The overall line at the top: one sentence and a coloured dot. */
export function OverallBanner({ overall, counts, generatedAt }: { overall: ServiceHealth; counts: { services: number; down: number; degraded: number; maintenance: number }; generatedAt: string }) {
  const Icon = HEALTH_ICON[overall];
  const text =
    overall === 'good'
      ? counts.services ? 'All services are operational' : 'No services are being tracked yet'
      : overall === 'down'
        ? `${counts.down} service${counts.down === 1 ? '' : 's'} affected by a major incident`
        : overall === 'maintenance'
          ? `${counts.maintenance} service${counts.maintenance === 1 ? '' : 's'} under planned maintenance`
          : `${counts.degraded} service${counts.degraded === 1 ? '' : 's'} degraded`;
  return (
    <div className={cn('rounded-xl border border-default bg-surface px-5 py-4 flex items-center gap-3 shadow-[0_1px_2px_rgba(9,9,11,0.04)]')} data-testid="status-overall">
      <span className={cn('h-9 w-9 rounded-full text-white flex items-center justify-center shrink-0', HEALTH_TONE[overall])}><Icon className="h-4.5 w-4.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{text}</div>
        <div className="text-[12px] text-muted">Checked {relativeTime(generatedAt)} · refreshes every two minutes</div>
      </div>
    </div>
  );
}

export function ServiceRow({ s, reasons }: { s: Pick<StatusService, 'name' | 'health'>; reasons: string[] }) {
  const Icon = HEALTH_ICON[s.health];
  return (
    <div className="flex items-start gap-3 py-2.5" data-testid="status-service">
      <span className={cn('mt-0.5 h-5 w-5 rounded-full text-white flex items-center justify-center shrink-0', HEALTH_TONE[s.health])}><Icon className="h-3 w-3" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[13.5px]">{s.name}</span>
          <Badge color={SERVICE_HEALTH_COLORS[s.health]}>{HEALTH_LABEL[s.health]}</Badge>
        </div>
        {reasons.length > 0 && <ul className="mt-0.5 text-[12.5px] text-muted flex flex-col gap-0.5">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      </div>
    </div>
  );
}

export function MaintenanceRow({ m }: { m: Pick<MaintenanceItem, 'kind' | 'title' | 'startsAt' | 'endsAt' | 'day' | 'status'> }) {
  const when = m.startsAt ? `${fmtDateTime(m.startsAt)}${m.endsAt ? ` – ${new Date(m.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}` : m.day ? fmtDate(m.day) : 'to be scheduled';
  const running = m.startsAt && new Date(m.startsAt).getTime() <= Date.now() && (!m.endsAt || new Date(m.endsAt).getTime() > Date.now());
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={cn('mt-0.5 h-5 w-5 rounded-md flex items-center justify-center shrink-0', m.kind === 'change' ? 'bg-violet-500/10 text-violet-700' : 'bg-emerald-500/10 text-emerald-700')}>{m.kind === 'change' ? <Wrench className="h-3 w-3" /> : <CalendarCheck className="h-3 w-3" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap"><span className="font-medium text-[13.5px]">{m.title}</span>{running && <Badge color="blue" dot>In progress</Badge>}</div>
        <div className="text-[12.5px] text-muted inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {when} · {m.kind === 'change' ? 'planned change' : 'preventive maintenance'}</div>
      </div>
    </div>
  );
}

/** The customer's status page: their business services with health, planned work, notices and incident banners. */
export default function PortalStatusPage() {
  const q = useQuery({ queryKey: ['portal', 'status'], queryFn: () => announcementsApi.portalStatus(), refetchInterval: 120_000, staleTime: 60_000 });
  const d = q.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Service status" subtitle="How your services are doing right now, what is planned, and what we have announced" />
      {q.isLoading && <LoadingBlock label="Checking your services…" />}
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      {d && (
        <>
          <OverallBanner overall={d.overall} counts={d.counts} generatedAt={d.generatedAt} />
          {d.incidents.map((i) => (
            <div key={i.ticketId} className="rounded-xl border border-red-200 bg-red-50 text-red-900 px-4 py-3 flex gap-3 items-start" role="status">
              <span className="h-7 w-7 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5"><Siren className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold flex items-center gap-2 flex-wrap"><span>Service incident in progress</span><Link to={`/portal/tickets/${i.ticketId}`} className="font-mono text-[12px] font-medium underline underline-offset-2">{i.number}</Link><span className="font-normal truncate">{i.title}</span></div>
                <div className="mt-1 text-[13px] whitespace-pre-wrap">{i.latestUpdate?.body ?? 'Our engineers are working on it. Updates will appear here and on the ticket.'}</div>
                <div className="mt-1 text-[11.5px] text-red-800/80">{i.latestUpdate ? `Updated ${relativeTime(i.latestUpdate.at)}` : `Declared ${relativeTime(i.declaredAt)}`}{i.nextUpdateDueAt && new Date(i.nextUpdateDueAt).getTime() > Date.now() ? ` · next update by ${fmtDateTime(i.nextUpdateDueAt)}` : ''}</div>
              </div>
            </div>
          ))}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <div className="xl:col-span-2 flex flex-col gap-5">
              <Panel title={<><Activity className="h-4 w-4 text-subtle" /> Services</>}>
                {d.services.length === 0 ? (
                  <EmptyState icon={<Activity className="h-5 w-5" />} title="No business services yet" description="Your service desk maps the services you rely on; their health appears here." />
                ) : (
                  <div className="divide-y divide-[var(--border)]">{d.services.map((s) => <ServiceRow key={s.id} s={s} reasons={s.reasons.map((r) => r.text)} />)}</div>
                )}
              </Panel>
              <Panel title={<><CalendarCheck className="h-4 w-4 text-subtle" /> Planned maintenance · next 14 days</>}>
                {d.maintenance.length === 0 ? <div className="text-[13px] text-muted py-2">Nothing planned in the next two weeks.</div> : <div className="divide-y divide-[var(--border)]">{d.maintenance.map((m) => <MaintenanceRow key={`${m.kind}-${m.id}`} m={m} />)}</div>}
              </Panel>
            </div>
            <div className="flex flex-col gap-3">
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle px-1">Announcements</div>
              {d.announcements.length === 0 ? <div className="card p-4 text-[13px] text-muted">No announcements right now.</div> : d.announcements.map((a) => <AnnouncementCard key={a.id} a={a} linkBase="/portal/tickets" />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
