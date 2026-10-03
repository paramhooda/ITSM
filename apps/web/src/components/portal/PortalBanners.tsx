import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Siren } from 'lucide-react';
import { get } from '@/api/client';
import { relativeTime, fmtDateTime } from '@/lib/format';
import type { PortalBanner } from './api';

/**
 * Service notices above every portal page: major incidents the service desk is announcing,
 * with the latest stakeholder update. Nothing renders when there is nothing to announce.
 */
export function PortalBanners() {
  const q = useQuery({ queryKey: ['portal', 'banners'], queryFn: () => get<{ items: PortalBanner[] }>('/portal/banners'), refetchInterval: 60_000, staleTime: 30_000 });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2 mb-5" data-testid="portal-banners">
      {items.map((b) => (
        <div key={b.ticketId} className="rounded-xl border border-red-200 bg-red-50 text-red-900 px-4 py-3 flex gap-3 items-start" role="status">
          <span className="h-7 w-7 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5">
            <Siren className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold flex items-center gap-2 flex-wrap">
              <span>Service incident in progress</span>
              <Link to={`/portal/tickets/${b.ticketId}`} className="font-mono text-[12px] font-medium underline underline-offset-2">{b.number}</Link>
              <span className="font-normal truncate">{b.title}</span>
            </div>
            {b.latestUpdate ? (
              <div className="mt-1 text-[13px] whitespace-pre-wrap">{b.latestUpdate.body}</div>
            ) : (
              <div className="mt-1 text-[13px]">Our engineers are working on it. Updates will appear here and on the ticket.</div>
            )}
            <div className="mt-1 text-[11.5px] text-red-800/80" title={b.latestUpdate ? fmtDateTime(b.latestUpdate.at) : fmtDateTime(b.declaredAt)}>
              {b.latestUpdate ? `Updated ${relativeTime(b.latestUpdate.at)}` : `Declared ${relativeTime(b.declaredAt)}`}
              {b.nextUpdateDueAt && new Date(b.nextUpdateDueAt).getTime() > Date.now() ? ` · next update by ${fmtDateTime(b.nextUpdateDueAt)}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
