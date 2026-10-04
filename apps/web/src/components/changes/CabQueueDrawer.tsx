import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gavel, Plus } from 'lucide-react';
import { Badge, Button, Drawer, EmptyState, Field, LoadingBlock, Select } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { CHANGE_RISK_COLORS } from '@/lib/statusColors';
import { changesApi, changeKeys, type CabQueueItem } from './api';

/** One change awaiting the board: number, title, customer, window, risk and the step it waits on. */
export function QueueRow({ r, action }: { r: CabQueueItem; action?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5" data-testid="cab-queue-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link to={`/tickets/${r.ticketId}?tab=plan`} className="font-mono text-[12.5px] font-medium text-brand-700 hover:underline">{r.number}</Link>
          <Badge color="slate" className="capitalize">{r.changeType}</Badge>
          {r.riskLevel ? <Badge color={CHANGE_RISK_COLORS[r.riskLevel] ?? 'slate'}>{r.riskLevel}{r.riskScore != null ? ` · ${r.riskScore}` : ''}</Badge> : <Badge color="slate">not assessed</Badge>}
        </div>
        <div className="text-[13px] truncate" title={r.title}>{r.title}</div>
        <div className="text-[11.5px] text-muted truncate">
          {r.customerName ?? '—'} · {r.scheduledStart ? `${fmtDateTime(r.scheduledStart)}${r.scheduledEnd ? ` – ${new Date(r.scheduledEnd).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'no window yet'}
          {r.pendingStep ? ` · waiting on: ${r.pendingStep.stepName ?? `step ${r.pendingStep.step}`}` : r.approvalStatus === 'pending' ? ' · approval pending' : ''}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The changes awaiting the board that are on no open agenda, each with an "Add" into the chosen upcoming meeting. */
export function CabQueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: changeKeys.queue({ limit: 50 }), queryFn: () => changesApi.queue({ limit: 50 }), enabled: open, staleTime: 10_000 });
  const mParams = { status: 'upcoming', page: 1, pageSize: 20 };
  const meetings = useQuery({ queryKey: changeKeys.meetings(mParams), queryFn: () => changesApi.meetings(mParams), enabled: open, staleTime: 15_000 });
  const [meetingId, setMeetingId] = useState('');
  const upcoming = meetings.data?.items ?? [];
  useEffect(() => {
    if (!meetingId && upcoming.length) setMeetingId(upcoming[0]!.id);
  }, [upcoming, meetingId]);
  const add = useMutation({
    mutationFn: (ticketId: string) => changesApi.addItem(meetingId, { ticketId }),
    onSuccess: (m) => {
      toast.success(`Added to the agenda of ${m.title}`);
      void qc.invalidateQueries({ queryKey: ['cab'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rows = queue.data?.items ?? [];
  return (
    <Drawer open={open} onClose={onClose} title="Awaiting CAB" width="max-w-xl" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] text-muted">Changes with a pending CAB step (or a pending approval) that sit on no open agenda. Pick the meeting, then add each change the board should see.</p>
        <Field label="Add to">
          {upcoming.length ? (
            <Select value={meetingId} onChange={(e) => setMeetingId(e.target.value)} options={upcoming.map((m) => ({ value: m.id, label: `${m.title} · ${fmtDateTime(m.scheduledAt)}` }))} />
          ) : (
            <div className="text-[12.5px] text-subtle">No upcoming meeting; create one with New meeting first.</div>
          )}
        </Field>
        {queue.isLoading ? (
          <LoadingBlock label="Looking for changes awaiting the board…" />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Gavel className="h-5 w-5" />} title="Nothing is waiting for the board" description="Every change with a pending CAB step is already on an agenda." />
        ) : (
          <div className="divide-y divide-[var(--border)]" data-testid="cab-queue">
            {rows.map((r) => (
              <QueueRow key={r.ticketId} r={r} action={<Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} disabled={!meetingId} loading={add.isPending && add.variables === r.ticketId} onClick={() => add.mutate(r.ticketId)}>Add</Button>} />
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
