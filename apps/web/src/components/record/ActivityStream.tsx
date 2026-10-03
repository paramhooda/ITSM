import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, ChevronDown, ChevronRight, MessageSquare, History, Sparkles, ArrowRightLeft, UserCheck, Flag, ShieldCheck, Link2, Server, ListChecks, Timer, AlertTriangle, ClipboardCheck, Eye, Pencil, Flame, Megaphone, type LucideIcon } from 'lucide-react';
import { get } from '@/api/client';
import { Avatar } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { Composer } from '@/components/tickets/Composer';
import { humanizeAction, formatValue, type AuditEntry } from '@/components/audit/AuditTrail';
import type { TimelineEntry } from '@/components/tickets/types';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';

/** One row of a record's activity: a comment, an internal note, a field change or a system event. */
export interface StreamEntry {
  id: string;
  at: string;
  actor?: string | null;
  kind: 'comment' | 'note' | 'change' | 'event';
  /** Short line for changes/events ("Status: Open → In progress"). */
  title?: ReactNode;
  /** Body for comments/notes, or extra detail for events. */
  body?: string | null;
  changes?: Record<string, { old: unknown; new: unknown }>;
  internal?: boolean;
  tone?: 'good' | 'bad' | 'warn';
  /** Lucide icon key for events (status, assignment, …). */
  icon?: string;
  minutesSpent?: number | null;
  editedAt?: string | null;
}

const ICONS: Record<string, LucideIcon> = { created: Sparkles, status: ArrowRightLeft, assignment: UserCheck, priority: Flag, scope: ShieldCheck, link: Link2, ci: Server, task: ListChecks, time: Timer, sla: Timer, escalation: AlertTriangle, approval: ClipboardCheck, watcher: Eye, update: Pencil, history: History, major: Flame, major_update: Megaphone };
const SECRET = /(password|secret|token|key|community)/i;

export const fromTimeline = (t: TimelineEntry): StreamEntry =>
  t.kind === 'comment'
    ? { id: t.id, at: t.createdAt, actor: t.actorName, kind: t.isInternal || t.type === 'work_note' ? 'note' : 'comment', body: t.body, internal: t.isInternal || t.type === 'work_note', tone: t.type === 'resolution' ? 'good' : undefined, minutesSpent: t.minutesSpent, editedAt: t.editedAt }
    : { id: t.id, at: t.createdAt, actor: t.actorName, kind: 'event', title: t.summary, body: t.type === 'status' && t.data?.resolutionNotes ? String(t.data.resolutionNotes) : null, internal: t.isInternal, icon: t.type, tone: t.type === 'escalation' || (t.type === 'major' && !t.data?.demoted) || (t.type === 'sla' && /breach/i.test(t.summary ?? '')) ? 'bad' : undefined };

export const fromAudit = (e: AuditEntry): StreamEntry => ({
  id: e.id,
  at: e.occurredAt,
  actor: e.userName ?? (e.source && e.source !== 'ui' ? titleCase(e.source) : 'System'),
  kind: e.action === 'comment' ? 'comment' : e.action === 'work_note' ? 'note' : 'change',
  title: humanizeAction(e.action) + (e.entityLabel && e.entityType !== 'ci' && !/^(ticket|contract|asset|customer|field_visit|kb_article)$/.test(e.entityType) ? ` · ${e.entityType.replace(/_/g, ' ')} ${e.entityLabel}` : ''),
  changes: e.changes && Object.keys(e.changes).length ? e.changes : undefined,
  icon: /delete|remove/.test(e.action) ? 'escalation' : /create|upload/.test(e.action) ? 'created' : 'update',
  tone: /delete|fail|lock/.test(e.action) ? 'bad' : undefined,
});

/** Audit rows for any entity, already in stream shape. */
export function useAuditStream(entityType: string, entityId: string | undefined, limit = 50) {
  const q = useQuery({ queryKey: ['audit', 'entity', entityType, entityId, limit], queryFn: () => get<{ items: AuditEntry[]; restricted: boolean }>(`/audit/entity/${entityType}/${entityId}`, { limit }), enabled: !!entityId, staleTime: 30_000 });
  return { ...q, entries: useMemo(() => (q.data?.items ?? []).map(fromAudit), [q.data]) };
}

function Changes({ changes }: { changes: Record<string, { old: unknown; new: unknown }> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(changes);
  return (
    <div className="mt-0.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-0.5 text-[11.5px] text-subtle hover:text-default">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {keys.length} field{keys.length === 1 ? '' : 's'}
      </button>
      {open && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
          {keys.map((k) => (
            <div key={k} className="contents">
              <dt className="text-muted whitespace-nowrap">{titleCase(k)}</dt>
              <dd className="min-w-0 break-all">
                <span className="line-through text-subtle">{SECRET.test(k) ? '••••' : formatValue(changes[k]!.old)}</span>
                <span className="text-subtle"> → </span>
                <span className="text-default">{SECRET.test(k) ? '••••' : formatValue(changes[k]!.new)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Row({ e, last }: { e: StreamEntry; last: boolean }) {
  if (e.kind === 'comment' || e.kind === 'note') {
    const internal = e.kind === 'note' || e.internal;
    return (
      <li className="flex gap-2.5">
        <div className="flex flex-col items-center">
          <Avatar name={e.actor ?? undefined} size="xs" className="mt-0.5" />
          {!last && <div className="flex-1 w-px bg-[var(--border)] mt-1" />}
        </div>
        <div className={cn('flex-1 min-w-0 mb-3 rounded-lg border px-3 py-2', internal ? 'border-amber-200/70 bg-amber-50/60' : e.tone === 'good' ? 'border-emerald-200/70 bg-emerald-50/50' : 'border-default bg-surface')}>
          <div className="flex items-center gap-2 text-[11.5px] text-muted mb-0.5 flex-wrap">
            <span className="font-medium text-default">{e.actor ?? 'Unknown'}</span>
            {internal && <span className="inline-flex items-center gap-1 text-amber-700"><Lock className="h-3 w-3" /> Internal</span>}
            {e.tone === 'good' && <span className="text-emerald-700">Resolution</span>}
            {e.minutesSpent ? <span className="text-subtle">· {e.minutesSpent} min</span> : null}
            <span className="ml-auto text-subtle" title={fmtDateTime(e.at)}>{relativeTime(e.at)}{e.editedAt ? ' · edited' : ''}</span>
          </div>
          <div className="text-[13px] whitespace-pre-wrap break-words">{e.body}</div>
        </div>
      </li>
    );
  }
  const Icon = ICONS[e.icon ?? ''] ?? Pencil;
  return (
    <li className="flex gap-2.5">
      <div className="flex flex-col items-center">
        <div className={cn('h-6 w-6 rounded-full flex items-center justify-center shrink-0', e.tone === 'bad' ? 'bg-red-100 text-red-700' : e.tone === 'good' ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-2 text-muted')}>
          <Icon className="h-3 w-3" />
        </div>
        {!last && <div className="flex-1 w-px bg-[var(--border)] mt-1" />}
      </div>
      <div className="flex-1 min-w-0 pb-2.5 pt-0.5">
        <div className="text-[12.5px] flex items-start gap-2 flex-wrap">
          <span className={cn('min-w-0', e.internal ? 'text-muted' : 'text-default')}>
            {e.title}
            {e.internal && <Lock className="inline h-3 w-3 ml-1 text-subtle align-[-2px]" />}
          </span>
          <span className="ml-auto text-[11.5px] text-subtle whitespace-nowrap" title={fmtDateTime(e.at)}>
            {e.actor ? `${e.actor} · ` : ''}{relativeTime(e.at)}
          </span>
        </div>
        {e.body && <div className="mt-0.5 text-[12.5px] text-muted whitespace-pre-wrap">{e.body}</div>}
        {e.changes && <Changes changes={e.changes} />}
      </div>
    </li>
  );
}

type Filter = 'all' | 'comments' | 'changes';

/**
 * One activity stream for every record: comments and notes as bubbles, field changes
 * and system events as a timeline, the composer on top like ServiceNow's journal.
 */
export function ActivityStream({ entries, loading, composer, title = 'Activity', emptyText = 'Nothing recorded yet.', className, maxHeight }: { entries: StreamEntry[]; loading?: boolean; composer?: Parameters<typeof Composer>[0]; title?: ReactNode; emptyText?: string; className?: string; maxHeight?: number | string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const hasComments = entries.some((e) => e.kind === 'comment' || e.kind === 'note');
  const shown = useMemo(() => {
    const sorted = [...entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return filter === 'all' ? sorted : filter === 'comments' ? sorted.filter((e) => e.kind === 'comment' || e.kind === 'note') : sorted.filter((e) => e.kind === 'change' || e.kind === 'event');
  }, [entries, filter]);
  return (
    <section className={cn('card flex flex-col', className)}>
      <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-default">
        <h2 className="text-[13px] font-semibold flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-subtle" /> {title} <span className="text-subtle font-normal tnum">{entries.length}</span>
        </h2>
        {hasComments && <Segmented size="sm" options={[{ value: 'all', label: 'All' }, { value: 'comments', label: 'Comments' }, { value: 'changes', label: 'Changes' }]} value={filter} onChange={setFilter} />}
      </header>
      {composer && (
        <div className="px-4 pt-3">
          <Composer {...composer} />
        </div>
      )}
      <div className="px-4 py-3 overflow-y-auto" style={maxHeight ? { maxHeight } : undefined}>
        {loading ? (
          <div className="text-[12.5px] text-muted">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="text-[12.5px] text-subtle py-2">{emptyText}</div>
        ) : (
          <ol>
            {shown.map((e, i) => (
              <Row key={e.id} e={e} last={i === shown.length - 1} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
