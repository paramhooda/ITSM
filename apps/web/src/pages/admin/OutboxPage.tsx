import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { get } from '@/api/client';
import { Button, Badge, StatTile, type Column } from '@/components/ui';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell, MonoCell } from '@/components/admin/ConfigTable';

interface OutboxRow {
  id: string;
  recipient: string;
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
  recent: OutboxRow[];
}

const STATUS_COLOR: Record<string, string> = { pending: 'amber', sending: 'blue', sent: 'green', failed: 'red', cancelled: 'gray' };

export default function OutboxPage() {
  const q = useQuery({ queryKey: ['notifications', 'outbox'], queryFn: () => get<OutboxStats>('/notifications/outbox'), refetchInterval: 30_000 });
  const by = q.data?.byStatus ?? {};
  const columns: Column<OutboxRow>[] = [
    { key: 'createdAt', header: 'Queued', render: (r) => <MutedCell><span title={fmtDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span></MutedCell> },
    { key: 'recipient', header: 'Recipient', render: (r) => <span className="text-[13px]">{r.recipient}</span> },
    { key: 'subject', header: 'Subject', render: (r) => (
      <div className="min-w-0">
        <div className="truncate max-w-md">{r.subject ?? '—'}</div>
        {r.event && <MonoCell>{r.event}</MonoCell>}
      </div>
    ) },
    { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'} dot>{titleCase(r.status)}</Badge> },
    { key: 'attempts', header: 'Attempts', render: (r) => <MutedCell>{r.attempts}</MutedCell> },
    { key: 'lastError', header: 'Error', render: (r) => (r.lastError ? <span className="text-[12px] text-red-600 break-all">{r.lastError}</span> : <MutedCell>—</MutedCell>) },
    { key: 'sentAt', header: 'Sent', render: (r) => <MutedCell>{r.sentAt ? fmtDateTime(r.sentAt) : '—'}</MutedCell> },
  ];
  return (
    <div>
      <SectionHeader title="Notification outbox" description="Outbound email written inside business transactions and delivered by the worker with retries." actions={<Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Pending" value={by.pending ?? 0} tone={(by.pending ?? 0) > 100 ? 'warn' : 'default'} hint="waiting for the worker" />
        <StatTile label="Sent" value={by.sent ?? 0} tone="good" />
        <StatTile label="Failed" value={by.failed ?? 0} tone={(by.failed ?? 0) > 0 ? 'bad' : 'default'} hint="exhausted retries" />
        <StatTile label="Other" value={Object.entries(by).filter(([k]) => !['pending', 'sent', 'failed'].includes(k)).reduce((a, [, v]) => a + v, 0)} hint={Object.keys(by).filter((k) => !['pending', 'sent', 'failed'].includes(k)).join(', ') || 'sending / cancelled'} />
      </div>
      <ConfigTable<OutboxRow> columns={columns} rows={q.data?.recent ?? []} loading={q.isLoading} error={q.error} retry={() => q.refetch()} emptyTitle="No messages yet" emptyDescription="Notifications appear here as soon as the platform sends email." />
    </div>
  );
}
