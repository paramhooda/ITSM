import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { get } from '@/api/client';
import { Button, Badge, StatTile, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { channelLabel } from '@/components/admin/notificationEvents';

interface OutboxRow {
  id: string;
  channel: string;
  recipient: string;
  deliveryStatus: string | null;
  subject: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  event: string | null;
}
interface OutboxStats {
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  recent: OutboxRow[];
}
const CHANNEL_COLOR: Record<string, string> = { email: 'blue', whatsapp: 'green' };
const DELIVERY_COLOR: Record<string, string> = { accepted: 'slate', sent: 'blue', delivered: 'green', read: 'green', failed: 'red' };
const STATUS_COLOR: Record<string, string> = { pending: 'amber', sending: 'blue', sent: 'green', failed: 'red', cancelled: 'gray' };
const STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled'];
/** How many of the latest messages the page holds; the tiles count the whole outbox. */
const RECENT = 500;

/**
 * The notification outbox: the tiles count every message by status, the table holds the
 * latest messages with the search, channel and status filters in the URL (`q`, `channel`,
 * `status`, `page`) and refreshes every half minute.
 */
export default function OutboxPage() {
  const q = useQuery({ queryKey: ['notifications', 'outbox', { limit: RECENT }], queryFn: () => get<OutboxStats>('/notifications/outbox', { limit: RECENT }), refetchInterval: 30_000 });
  const by = q.data?.byStatus ?? {};
  const all = useMemo(() => q.data?.recent ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.recipient, (r) => r.subject, (r) => r.event, (r) => r.lastError, (r) => r.deliveryStatus],
    selects: [
      { key: 'channel', label: 'Channel', options: [{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }], predicate: (r, v) => r.channel === v },
      { key: 'status', label: 'Status', options: STATUSES.map((s) => ({ value: s, label: titleCase(s) })), predicate: (r, v) => r.status === v },
    ],
    noun: ['recent message', 'recent messages'],
    searchPlaceholder: 'Recipient, subject, event, error',
  });
  const columns: Column<OutboxRow>[] = [
    { key: 'createdAt', header: 'Queued', render: (r) => <MutedCell><span className="whitespace-nowrap" title={fmtDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span></MutedCell> },
    { key: 'channel', header: 'Channel', render: (r) => <Badge color={CHANNEL_COLOR[r.channel] ?? 'slate'}>{channelLabel(r.channel)}</Badge> },
    { key: 'recipient', header: 'Recipient', render: (r) => <span className="text-[13px]">{r.recipient}</span> },
    { key: 'subject', header: 'Subject', render: (r) => (
      <div className="min-w-0">
        <div className="truncate max-w-md">{r.subject ?? '—'}</div>
        {r.event && <MonoCell>{r.event}</MonoCell>}
      </div>
    ) },
    { key: 'status', header: 'Status', render: (r) => <span className="inline-flex items-center gap-1"><Badge color={STATUS_COLOR[r.status] ?? 'slate'} dot>{titleCase(r.status)}</Badge>{r.deliveryStatus && <Badge color={DELIVERY_COLOR[r.deliveryStatus] ?? 'slate'}>{titleCase(r.deliveryStatus)}</Badge>}</span> },
    { key: 'attempts', header: 'Attempts', render: (r) => <MutedCell>{r.attempts}</MutedCell> },
    { key: 'lastError', header: 'Error', render: (r) => (r.lastError ? <span className="text-[12px] text-red-600 break-all">{r.lastError}</span> : <MutedCell>—</MutedCell>) },
    { key: 'sentAt', header: 'Sent', render: (r) => <MutedCell>{r.sentAt ? fmtDateTime(r.sentAt) : '—'}</MutedCell> },
  ];
  return (
    <div>
      <SectionHeader title="Notification outbox" description="Outbound email and WhatsApp messages written inside business transactions and delivered by the worker with retries." />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Pending" value={by.pending ?? 0} tone={(by.pending ?? 0) > 100 ? 'warn' : 'default'} hint="waiting for the worker" />
        <StatTile label="Sent" value={by.sent ?? 0} tone="good" />
        <StatTile label="Failed" value={by.failed ?? 0} tone={(by.failed ?? 0) > 0 ? 'bad' : 'default'} hint="exhausted retries" />
        <StatTile label="Other" value={Object.entries(by).filter(([k]) => !['pending', 'sent', 'failed'].includes(k)).reduce((a, [, v]) => a + v, 0)} hint={Object.keys(by).filter((k) => !['pending', 'sent', 'failed'].includes(k)).join(', ') || 'sending / cancelled'} />
      </div>
      <ConfigToolbar {...f.toolbar}>
        <Button variant="outline" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
      </ConfigToolbar>
      <ConfigTable<OutboxRow>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        emptyTitle={f.filtered ? 'No messages match' : 'No messages yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Notifications appear here as soon as the platform sends email or WhatsApp messages.'}
      />
    </div>
  );
}
