import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Info, Wrench, Siren, Pin, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { relativeTime, fmtDateTime } from '@/lib/format';
import { announcementsApi, announcementKeys, type Announcement, type AnnouncementType } from './api';

/** Banner tone per announcement type: calm blue for news, amber for planned work, red for an outage. */
const TONE: Record<AnnouncementType, { wrap: string; badge: string; Icon: typeof Info; label: string }> = {
  info: { wrap: 'border-blue-200 bg-blue-50 text-blue-900', badge: 'bg-blue-600', Icon: Info, label: 'Notice' },
  maintenance: { wrap: 'border-amber-200 bg-amber-50 text-amber-900', badge: 'bg-amber-500', Icon: Wrench, label: 'Planned maintenance' },
  outage: { wrap: 'border-red-200 bg-red-50 text-red-900', badge: 'bg-red-600', Icon: Siren, label: 'Service disruption' },
};

const DISMISS_KEY = 'announcements.dismissed';
const readDismissed = (): Record<string, string> => {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

/**
 * One announcement as a banner. Pinned ones cannot be dismissed; the others hide for the
 * session once closed (per browser, a convenience only) and come back when they change.
 */
export function AnnouncementCard({ a, onDismiss, linkBase }: { a: Announcement; onDismiss?: () => void; linkBase?: string }) {
  const t = TONE[a.type] ?? TONE.info;
  const ticketLink = a.sourceTicket && linkBase ? `${linkBase}/${a.sourceTicket.id}` : null;
  return (
    <div className={cn('rounded-xl border px-4 py-3 flex gap-3 items-start', t.wrap)} role="status" data-testid="announcement">
      <span className={cn('h-7 w-7 rounded-full text-white flex items-center justify-center shrink-0 mt-0.5', t.badge)}>
        <t.Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold flex items-center gap-2 flex-wrap">
          <span className="uppercase tracking-wide text-[10.5px] opacity-70">{t.label}</span>
          {a.pinned && <Pin className="h-3 w-3 opacity-60" aria-label="Pinned" />}
          <span>{a.title}</span>
          {ticketLink && <Link to={ticketLink} className="font-mono text-[12px] font-medium underline underline-offset-2">{a.sourceTicket!.number}</Link>}
        </div>
        <div className="mt-1 text-[13px] whitespace-pre-wrap">{a.body}</div>
        <div className="mt-1 text-[11.5px] opacity-70" title={fmtDateTime(a.startsAt)}>
          Posted {relativeTime(a.startsAt)}
          {a.endsAt ? ` · until ${fmtDateTime(a.endsAt)}` : ''}
        </div>
      </div>
      {onDismiss && !a.pinned && (
        <button type="button" onClick={onDismiss} className="opacity-60 hover:opacity-100 shrink-0 -mr-1 -mt-1 p-1 rounded-md" aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** A list of announcement banners with per-session dismissal. */
export function AnnouncementList({ items, linkBase, className }: { items: Announcement[]; linkBase?: string; className?: string }) {
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => readDismissed());
  useEffect(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
    } catch {
      /* private window */
    }
  }, [dismissed]);
  const shown = items.filter((a) => a.pinned || dismissed[a.id] !== a.updatedAt);
  if (!shown.length) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="announcements">
      {shown.map((a) => (
        <AnnouncementCard key={a.id} a={a} linkBase={linkBase} onDismiss={() => setDismissed((d) => ({ ...d, [a.id]: a.updatedAt }))} />
      ))}
    </div>
  );
}

/** The staff shell's strip under the header: live announcements for everyone or for staff. */
export function AnnouncementBanner() {
  const user = useAuthStore((s) => s.user);
  const q = useQuery({ queryKey: announcementKeys.active, queryFn: announcementsApi.active, refetchInterval: 60_000, staleTime: 30_000, enabled: !!user });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="px-4 md:px-6 pt-3 max-w-[1500px] w-full mx-auto">
      <AnnouncementList items={items} linkBase="/tickets" />
    </div>
  );
}
