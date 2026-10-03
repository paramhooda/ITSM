import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, CalendarCheck, Siren, Globe } from 'lucide-react';
import { PageHeader, EmptyState, LoadingBlock } from '@/components/ui';
import { BrandLogo } from '@/layouts/AppShell';
import { Panel } from '@/components/tickets/Panel';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { fetchPublicStatus, type AnnouncementType } from '@/components/announcements/api';
import { OverallBanner, ServiceRow, MaintenanceRow } from '@/pages/portal/PortalStatusPage';
import { cn } from '@/lib/utils';

const TONE: Record<AnnouncementType, string> = { info: 'border-blue-200 bg-blue-50 text-blue-900', maintenance: 'border-amber-200 bg-amber-50 text-amber-900', outage: 'border-red-200 bg-red-50 text-red-900' };

/**
 * The public status page behind a token link: no sign-in, no record ids, the customer's
 * services in plain words. Rendered outside both shells.
 */
export default function PublicStatusPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['public', 'status', token], queryFn: () => fetchPublicStatus(token), refetchInterval: 120_000, staleTime: 60_000, retry: false, enabled: !!token });
  const d = q.data;
  return (
    <div className="min-h-full bg-app">
      <header className="h-14 flex items-center gap-3 px-4 md:px-6 border-b border-default bg-surface">
        <BrandLogo />
        <span className="text-[13px] text-muted inline-flex items-center gap-1"><Globe className="h-3.5 w-3.5" /> Service status</span>
      </header>
      <main className="p-5 md:p-7 max-w-[1100px] mx-auto flex flex-col gap-5">
        {q.isLoading && <LoadingBlock label="Checking the services…" />}
        {!q.isLoading && !d && (
          <>
            <PageHeader title="Status page" />
            <EmptyState icon={<Globe className="h-5 w-5" />} title="This link is not valid" description="The status page link may have been revoked. Ask your service provider for a current one." />
          </>
        )}
        {d && (
          <>
            <PageHeader title={`${d.customer.name} · service status`} subtitle={`${d.page.label} · checked ${relativeTime(d.generatedAt)}`} />
            <OverallBanner overall={d.overall} counts={d.counts} generatedAt={d.generatedAt} />
            {d.incidents.map((i, idx) => (
              <div key={idx} className="rounded-xl border border-red-200 bg-red-50 text-red-900 px-4 py-3 flex gap-3 items-start" role="status">
                <span className="h-7 w-7 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5"><Siren className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">Service incident in progress · {i.title}</div>
                  <div className="mt-1 text-[13px] whitespace-pre-wrap">{i.latestUpdate?.body ?? 'Engineers are working on it. Updates will appear here.'}</div>
                  <div className="mt-1 text-[11.5px] text-red-800/80">{i.latestUpdate ? `Updated ${relativeTime(i.latestUpdate.at)}` : `Declared ${relativeTime(i.declaredAt)}`}{i.nextUpdateDueAt && new Date(i.nextUpdateDueAt).getTime() > Date.now() ? ` · next update by ${fmtDateTime(i.nextUpdateDueAt)}` : ''}</div>
                </div>
              </div>
            ))}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
              <div className="xl:col-span-2 flex flex-col gap-5">
                <Panel title={<><Activity className="h-4 w-4 text-subtle" /> Services</>}>
                  {d.services.length === 0 ? <div className="text-[13px] text-muted py-2">No services are being tracked yet.</div> : <div className="divide-y divide-[var(--border)]">{d.services.map((s, i) => <ServiceRow key={i} s={s} reasons={s.reasons} />)}</div>}
                </Panel>
                <Panel title={<><CalendarCheck className="h-4 w-4 text-subtle" /> Planned maintenance · next 14 days</>}>
                  {d.maintenance.length === 0 ? <div className="text-[13px] text-muted py-2">Nothing planned in the next two weeks.</div> : <div className="divide-y divide-[var(--border)]">{d.maintenance.map((m, i) => <MaintenanceRow key={i} m={m} />)}</div>}
                </Panel>
              </div>
              <div className="flex flex-col gap-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle px-1">Announcements</div>
                {d.announcements.length === 0 ? (
                  <div className="card p-4 text-[13px] text-muted">No announcements right now.</div>
                ) : (
                  d.announcements.map((a) => (
                    <div key={a.id} className={cn('rounded-xl border px-4 py-3', TONE[a.type] ?? TONE.info)}>
                      <div className="text-[13px] font-semibold">{a.title}</div>
                      <div className="mt-1 text-[13px] whitespace-pre-wrap">{a.body}</div>
                      <div className="mt-1 text-[11.5px] opacity-70">Posted {relativeTime(a.startsAt)}{a.endsAt ? ` · until ${fmtDateTime(a.endsAt)}` : ''}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="text-[11.5px] text-subtle text-center">Updated automatically. For help, contact your service desk.</div>
          </>
        )}
      </main>
    </div>
  );
}
