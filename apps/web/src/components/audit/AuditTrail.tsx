import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { get } from '@/api/client';
import { Avatar, Badge, Button } from '@/components/ui';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface AuditEntry {
  id: string;
  occurredAt: string;
  userId?: string | null;
  userName: string | null;
  customerId?: string | null;
  customerName?: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  source?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  publish: 'Published',
  archive: 'Archived',
  unarchive: 'Restored to draft',
  restore_version: 'Restored a previous version',
  upload: 'Uploaded',
  download: 'Downloaded',
  'attachment.added': 'Added an attachment',
  'attachment.removed': 'Removed an attachment',
  'feedback.helpful': 'Marked as helpful',
  'feedback.not_helpful': 'Marked as not helpful',
  login: 'Signed in',
  'login.failed': 'Failed sign-in',
  'login.locked': 'Account locked',
  'password.changed': 'Changed password',
  'password.admin_reset': 'Password reset by administrator',
  assign: 'Assigned',
  resolve: 'Resolved',
  close: 'Closed',
  reopen: 'Reopened',
  escalate: 'Escalated',
  comment: 'Commented',
  work_note: 'Added a work note',
  status_change: 'Changed status',
  export: 'Exported',
};

export function humanizeAction(action: string) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const [head, ...rest] = action.split('.');
  if (rest.length) return `${titleCase(head)}: ${titleCase(rest.join(' '))}`;
  return titleCase(action);
}

const SECRET = /(password|secret|token|api[_-]?key|community|credential|hash)/i;

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return fmtDateTime(v);
    return v.length > 160 ? `${v.slice(0, 157)}…` : v;
  }
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : '—';
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  } catch {
    return String(v);
  }
}

const ACTION_COLORS: Record<string, string> = { create: 'green', upload: 'green', delete: 'red', 'attachment.removed': 'red', publish: 'blue', archive: 'slate', 'login.failed': 'red', 'login.locked': 'red', escalate: 'orange', resolve: 'green', close: 'slate' };

/** Timeline of audit entries for one record: actor, humanised action, relative time and expandable field changes. */
export function AuditTrail({ entityType, entityId, compact = false, limit = 50 }: { entityType: string; entityId: string; compact?: boolean; limit?: number }) {
  const [max, setMax] = useState(limit);
  const q = useQuery({
    queryKey: ['audit', 'entity', entityType, entityId, max],
    queryFn: () => get<{ items: AuditEntry[]; restricted: boolean }>(`/audit/entity/${entityType}/${entityId}`, { limit: max }),
    enabled: !!entityId,
  });
  const items = q.data?.items ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (q.isLoading) return <div className="text-xs text-muted py-2">Loading history…</div>;
  if (q.isError) return <div className="text-xs text-red-600 py-2">{(q.error as Error).message}</div>;
  if (!items.length) return <div className="text-xs text-muted py-2 flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> No history yet.</div>;

  return (
    <div className={cn('text-[13px]', compact && 'text-[12.5px]')}>
      <ol className="relative border-l border-default ml-3">
        {items.map((e) => {
          const hasChanges = e.changes && Object.keys(e.changes).length > 0;
          const hasMeta = e.metadata && Object.keys(e.metadata).length > 0;
          const expandable = hasChanges || (!compact && hasMeta);
          const isOpen = !!open[e.id];
          return (
            <li key={e.id} className={cn('ml-4 pb-3 last:pb-0')}>
              <span className="absolute -left-[13px] mt-0.5">
                <Avatar name={e.userName ?? 'System'} size="xs" />
              </span>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{e.userName ?? 'System'}</span>
                <Badge color={ACTION_COLORS[e.action] ?? 'slate'} className="py-0 text-[10.5px]">
                  {humanizeAction(e.action)}
                </Badge>
                {!compact && e.source && e.source !== 'ui' && <span className="text-[10.5px] uppercase text-subtle">{e.source}</span>}
                <span className="text-subtle text-xs" title={fmtDateTime(e.occurredAt)}>
                  {relativeTime(e.occurredAt)}
                </span>
                {expandable && (
                  <button className="text-subtle hover:text-default inline-flex items-center text-xs" onClick={() => setOpen((o) => ({ ...o, [e.id]: !isOpen }))}>
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {hasChanges ? `${Object.keys(e.changes).length} field${Object.keys(e.changes).length === 1 ? '' : 's'}` : 'details'}
                  </button>
                )}
              </div>
              {isOpen && hasChanges && (
                <table className="mt-1.5 text-xs w-full border border-default rounded-md overflow-hidden">
                  <thead>
                    <tr className="bg-surface-2 text-muted">
                      <th className="text-left px-2 py-1 font-medium">Field</th>
                      <th className="text-left px-2 py-1 font-medium">Before</th>
                      <th className="text-left px-2 py-1 font-medium">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(e.changes).map(([field, ch]) => {
                      const secret = SECRET.test(field);
                      return (
                        <tr key={field} className="border-t border-default align-top">
                          <td className="px-2 py-1 font-medium whitespace-nowrap">{titleCase(field)}</td>
                          <td className="px-2 py-1 text-muted break-all">{secret ? '••••••' : formatValue(ch.old)}</td>
                          <td className="px-2 py-1 break-all">{secret ? '••••••' : formatValue(ch.new)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {isOpen && !hasChanges && hasMeta && (
                <div className="mt-1 text-xs text-muted">
                  {Object.entries(e.metadata ?? {}).map(([k, v]) => (
                    <div key={k}>
                      <span className="font-medium">{titleCase(k)}:</span> {SECRET.test(k) ? '••••••' : formatValue(v)}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {items.length >= max && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setMax((m) => m + 100)}>
          Load more
        </Button>
      )}
    </div>
  );
}

export default AuditTrail;
