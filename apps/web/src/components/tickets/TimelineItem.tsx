import { Lock, ArrowRightLeft, UserCheck, Flag, ShieldCheck, Link2, Server, ListChecks, Timer, AlertTriangle, ClipboardCheck, Eye, Pencil, Sparkles, type LucideIcon } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fmtDateTime, relativeTime } from '@/lib/format';
import type { TimelineEntry } from './types';

const ICONS: Record<string, LucideIcon> = {
  created: Sparkles,
  status: ArrowRightLeft,
  assignment: UserCheck,
  priority: Flag,
  scope: ShieldCheck,
  link: Link2,
  ci: Server,
  task: ListChecks,
  time: Timer,
  sla: Timer,
  escalation: AlertTriangle,
  approval: ClipboardCheck,
  watcher: Eye,
  update: Pencil,
};

/** One row of the merged comments + activities timeline. Internal entries get a lock and a muted treatment. */
export function TimelineItem({ item, isLast }: { item: TimelineEntry; isLast?: boolean }) {
  if (item.kind === 'comment') {
    const internal = item.isInternal || item.type === 'work_note';
    const resolution = item.type === 'resolution';
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <Avatar name={item.actorName} size="sm" />
          {!isLast && <div className="flex-1 w-px bg-[var(--border)] mt-1" />}
        </div>
        <div className={cn('flex-1 min-w-0 mb-4 rounded-lg border px-3 py-2', internal ? 'border-amber-200/70 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5' : resolution ? 'border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-default bg-surface')}>
          <div className="flex items-center gap-2 text-[12px] text-muted mb-1 flex-wrap">
            <span className="font-medium text-default">{item.actorName ?? 'Unknown'}</span>
            {internal && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <Lock className="h-3 w-3" /> Internal note
              </span>
            )}
            {resolution && <span className="text-emerald-700 dark:text-emerald-300">Resolution</span>}
            {item.minutesSpent ? <span className="text-subtle">· {item.minutesSpent} min</span> : null}
            <span className="ml-auto text-subtle" title={fmtDateTime(item.createdAt)}>
              {relativeTime(item.createdAt)}
              {item.editedAt ? ' · edited' : ''}
            </span>
          </div>
          <div className="text-[13.5px] whitespace-pre-wrap break-words">{item.body}</div>
        </div>
      </div>
    );
  }
  const Icon = ICONS[item.type] ?? Pencil;
  const d = item.data ?? {};
  const detail = item.type === 'status' && d.resolutionNotes ? String(d.resolutionNotes) : null;
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn('h-7 w-7 rounded-full flex items-center justify-center shrink-0', item.type === 'escalation' || (item.type === 'sla' && /breach/i.test(item.summary ?? '')) ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-surface-2 text-muted')}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        {!isLast && <div className="flex-1 w-px bg-[var(--border)] mt-1" />}
      </div>
      <div className="flex-1 min-w-0 pb-3 pt-1">
        <div className="text-[12.5px] flex items-start gap-2 flex-wrap">
          <span className={cn(item.isInternal ? 'text-muted' : 'text-default')}>
            {item.summary}
            {item.isInternal && <Lock className="inline h-3 w-3 ml-1 text-subtle align-[-2px]" />}
          </span>
          <span className="ml-auto text-[11.5px] text-subtle whitespace-nowrap" title={fmtDateTime(item.createdAt)}>
            {item.actorName ? `${item.actorName} · ` : ''}
            {relativeTime(item.createdAt)}
          </span>
        </div>
        {detail && <div className="mt-1 text-[12.5px] text-muted whitespace-pre-wrap">{detail}</div>}
      </div>
    </div>
  );
}
