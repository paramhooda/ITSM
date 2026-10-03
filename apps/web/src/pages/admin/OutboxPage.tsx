import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Segmented } from '@/components/dashboards/Panel';
import { get } from '@/api/client';
import { Button, Badge, StatTile, type Column } from '@/components/ui';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell, MonoCell } from '@/components/admin/ConfigTable';

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

export default function OutboxPage() {
  const [channel, setChannel] = useState<'all' | 'email' | 'whatsapp'>('all');
  const q = useQuery({ queryKey: ['notifications', 'outbox', channel], queryFn: () => get<OutboxStats>('/notifications/outbox', channel === 'all' ? {} : { channel }), refetchInterval: 30_000 });
  const by = q.data?.byStatus ?? {};
  const columns: Column<OutboxRow>[] = [
    { key: 'createdAt', header: 'Queued', render: (r) => <MutedCell><span title={fmtDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span></MutedCell> },
    { key: 'channel', header: 'Channel', render: (r) => <Badge color={CHANNEL_COLOR[r.channel] ?? 'slate'}>{r.channel === 'whatsapp' ? 'WhatsApp' : titleCase(r.channel)}</Badge> },
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
      <SectionHeader title="Notification outbox" description="Outbound email and WhatsApp messages written inside business transactions and delivered by the worker with retries." actions={<span className="inline-flex items-center gap-2"><Segmented size="sm" options={[{ value: 'all', label: 'All' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }]} value={channel} onChange={setChannel} /><Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button></span>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Pending" value={by.pending ?? 0} tone={(by.pending ?? 0) > 100 ? 'warn' : 'default'} hint="waiting for the worker" />
        <StatTile label="Sent" value={by.sent ?? 0} tone="good" />
        <StatTile label="Failed" value={by.failed ?? 0} tone={(by.failed ?? 0) > 0 ? 'bad' : 'default'} hint="exhausted retries" />
        <StatTile label="Other" value={Object.entries(by).filter(([k]) => !['pending', 'sent', 'failed'].includes(k)).reduce((a, [, v]) => a + v, 0)} hint={Object.keys(by).filter((k) => !['pending', 'sent', 'failed'].includes(k)).join(', ') || 'sending / cancelled'} />
      </div>
      <ConfigTable<OutboxRow> columns={columns} rows={q.data?.recent ?? []} loading={q.isLoading} error={q.error} retry={() => q.refetch()} emptyTitle="No messages yet" emptyDescription="Notifications appear here as soon as the platform sends email or WhatsApp messages." />
    </div>
  );
}
